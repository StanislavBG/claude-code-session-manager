'use strict';

/**
 * jobLeftovers.cjs — read-only detection of processes that outlived their
 * scheduler job.
 *
 * Why it exists: the post-exit group sweep only reaches the job's own process
 * group. A child that called setsid (pnpm dev trees: concurrently, tsx watch,
 * vite; Playwright web servers) escapes that group, so run metas report
 * leakedDescendants [] while the tree runs for days.
 *
 * Identity is the SM_SCHEDULER_JOB_SLUG environment marker every job process
 * inherits — never cwd or command line (the scheduler's own git/gate commands
 * run in retained worktrees without the marker). Linux /proc only; no signal
 * is sent here.
 */

const fs = require('node:fs');
const path = require('node:path');
const { isClaudeArgv } = require('./reaperHelpers.cjs');
const procIdentity = require('../process/procIdentity.cjs');

const LEFTOVER_GRACE_MS = 120000;
const MARKER = 'SM_SCHEDULER_JOB_SLUG=';
const LIVE_STATUSES = new Set(['running', 'investigating', 'pending']);

function parseStat(raw) {
  const open = raw.indexOf('(');
  const close = raw.lastIndexOf(')');
  if (open === -1 || close === -1 || close < open) return null;
  const f = raw.slice(close + 1).trim().split(/\s+/);
  const ppid = Number(f[1]);
  if (f.length < 20 || !Number.isFinite(ppid)) return null;
  return {
    comm: raw.slice(open + 1, close),
    state: f[0],
    ppid,
    tty: Number(f[4]) || 0,
    utime: Number(f[11]) || 0,
    stime: Number(f[12]) || 0,
    startTicks: Number(f[19]) || 0,
  };
}

function scanJobProcesses({ fsImpl = fs, procRoot = process.env.SM_PROC_ROOT || '/proc', platform = process.platform } = {}) {
  const empty = () => ({ procs: [], parentOf: new Map() });
  if (platform !== 'linux') return empty();
  let names;
  try {
    names = fsImpl.readdirSync(procRoot);
  } catch {
    return empty();
  }
  let uptime = 0;
  try {
    uptime = Number(String(fsImpl.readFileSync(path.join(procRoot, 'uptime'), 'utf8')).split(/\s+/)[0]) || 0;
  } catch { /* leave 0 */ }

  const procs = [];
  const parentOf = new Map();
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    const dir = path.join(procRoot, name);
    try {
      const st = parseStat(String(fsImpl.readFileSync(path.join(dir, 'stat'), 'utf8')));
      if (!st) continue;
      parentOf.set(pid, st.ppid);
      let env;
      try {
        env = String(fsImpl.readFileSync(path.join(dir, 'environ'), 'utf8')).split('\0');
      } catch { continue; }
      const entry = env.find((e) => e.startsWith(MARKER));
      if (!entry || st.state === 'Z') continue;
      const slug = entry.slice(MARKER.length);
      let argv = [];
      try {
        argv = String(fsImpl.readFileSync(path.join(dir, 'cmdline'), 'utf8')).split('\0');
        if (argv.length && argv[argv.length - 1] === '') argv.pop();
      } catch { /* empty argv */ }
      let cwd = null;
      try {
        cwd = String(fsImpl.readlinkSync(path.join(dir, 'cwd'))).replace(/ \(deleted\)$/, '');
      } catch { /* null */ }
      const etimes = Math.max(0, uptime - st.startTicks / 100);
      const pcpu = etimes > 0 ? (((st.utime + st.stime) / 100) / etimes) * 100 : 0;
      procs.push({ pid, ppid: st.ppid, tty: st.tty, slug, argv, cwd, comm: st.comm, startTicks: st.startTicks, etimes, pcpu });
    } catch { /* pid vanished or denied mid-scan */ }
  }
  return { procs, parentOf };
}

function rowEndedMs(row) {
  if (row && row.finishedAt) {
    const t = Date.parse(row.finishedAt);
    if (Number.isFinite(t)) return t;
  }
  const h = row && Array.isArray(row.statusHistory) ? row.statusHistory : [];
  if (h.length) {
    const t = Date.parse(h[h.length - 1] && h[h.length - 1].at);
    if (Number.isFinite(t)) return t;
  }
  return null;
}

function selectLeftovers({ scan, rows, runningSlugs, now, selfPid } = {}) {
  const procs = (scan && scan.procs) || [];
  const parentOf = (scan && scan.parentOf) || new Map();
  const allRows = Array.isArray(rows) ? rows : [];
  const running = runningSlugs instanceof Set ? runningSlugs : new Set(runningSlugs || []);

  const bySlug = new Map();
  for (const p of procs) {
    if (!bySlug.has(p.slug)) bySlug.set(p.slug, []);
    bySlug.get(p.slug).push(p);
  }

  const ancestors = new Set();
  let cur = selfPid;
  for (let i = 0; i < 64 && cur != null && parentOf.has(cur); i++) {
    cur = parentOf.get(cur);
    if (!cur || ancestors.has(cur)) break;
    ancestors.add(cur);
  }
  const isDescendant = (pid) => {
    let c = pid;
    for (let i = 0; i < 64 && parentOf.has(c); i++) {
      c = parentOf.get(c);
      if (c === selfPid) return true;
      if (!c) return false;
    }
    return false;
  };

  const out = [];
  for (const [slug, list] of bySlug) {
    if (running.has(slug)) continue;
    if (list.some((p) => isClaudeArgv(p.argv))) continue;
    const slugRows = allRows.filter((r) => r && r.slug === slug);
    if (slugRows.some((r) => LIVE_STATUSES.has(r.status))) continue;
    let ended = true;
    for (const r of slugRows) {
      const t = rowEndedMs(r);
      if (t == null || now - t < LEFTOVER_GRACE_MS) { ended = false; break; }
    }
    if (!ended) continue;
    const keep = list.filter((p) => !(p.tty !== 0 || p.pid === selfPid || ancestors.has(p.pid) || isDescendant(p.pid)));
    if (keep.length) out.push({ slug, procs: keep });
  }
  return out;
}

/**
 * stopLeftovers(procs, deps) — SIGTERM each pid, then after graceMs SIGKILL only
 * pids whose live identity is complete and not a different process from the one
 * recorded before SIGTERM (a recycled pid is never killed). Never throws.
 * Returns the pids that were signalled.
 */
function stopLeftovers(procs, {
  kill = process.kill.bind(process),
  identityOf = procIdentity.identity,
  isDifferentProcess = procIdentity.isDifferentProcess,
  setTimer = setTimeout,
  graceMs = 5000,
} = {}) {
  const recorded = new Map();
  const signalled = [];
  for (const p of Array.isArray(procs) ? procs : []) {
    const pid = p && p.pid;
    if (!Number.isInteger(pid) || pid <= 1) continue;
    try { recorded.set(pid, identityOf(pid)); } catch { recorded.set(pid, null); }
    try {
      kill(pid, 'SIGTERM');
      signalled.push(pid);
    } catch { /* already gone */ }
  }
  if (signalled.length === 0) return signalled;
  const timer = setTimer(() => {
    for (const pid of signalled) {
      try {
        const live = identityOf(pid);
        if (!live || live.complete !== true) continue;
        if (isDifferentProcess(recorded.get(pid), live)) continue;
        kill(pid, 'SIGKILL');
      } catch { /* gone */ }
    }
  }, graceMs);
  if (timer && typeof timer.unref === 'function') timer.unref();
  return signalled;
}

/**
 * listJobSurvivors(slug, pid, opts) — every scanned process carrying the job's
 * SM_SCHEDULER_JOB_SLUG marker except `pid` itself, whatever its process group or
 * session. opts is passed to scanJobProcesses (injectable fs/procRoot/platform).
 */
function listJobSurvivors(slug, pid, opts) {
  const { procs } = scanJobProcesses(opts);
  return procs
    .filter((p) => p.slug === slug && p.pid !== pid)
    .map((p) => ({ pid: p.pid, pcpu: Math.round(p.pcpu * 10) / 10, etimes: Math.round(p.etimes), comm: p.comm }));
}

module.exports = { scanJobProcesses, listJobSurvivors, selectLeftovers, stopLeftovers, LEFTOVER_GRACE_MS };

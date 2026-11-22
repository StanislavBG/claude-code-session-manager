'use strict';

/**
 * cpuSample.cjs — measured machine-wide CPU use over a real window.
 *
 * The 1-minute load average counts parked D-state tasks and short bursts, so
 * it can read high on a mostly idle machine (2026-11-01, 14 CPUs: 25 D-state
 * tasks gave loadavg1 22.39 while the CPU was only 24% busy over 75 s). This
 * helper derives busy/total from cumulative counters over a window of about a
 * minute instead. Pure and injectable (`read`, `readOwn`, `now`).
 *
 * Own-process exclusion (PRD 3495): 2026-11-22 the gate held launches at
 * loadavg ratios 2.21 … 1.01 on 14 cores while this app's own renderer averaged
 * ~81% CPU and main ~45%. The app must not gate on its own load, so the sampler
 * also tracks the app's own process tree (main + Electron `--type=` helpers:
 * zygote, renderer, GPU, utility) from /proc/<pid>/stat and reports busy both
 * raw and net of it. Spawned jobs (claude -p and their children) are NOT own
 * processes — they carry no `--type=` flag — so they stay in the net figure.
 * /proc/stat and /proc/<pid>/stat are both in USER_HZ clock ticks, so the
 * deltas subtract directly. Off Linux the own reading is null and net = raw.
 */

const fs = require('node:fs');
const os = require('node:os');

// Matches the 1-minute load average's horizon.
const DEFAULT_WINDOW_MS = 60_000;
// Anything shorter is a snapshot, not a sample: the two readings that started
// this work were 8 s long and fell in quiet gaps.
const MIN_WINDOW_MS = 20_000;
const MAX_WINDOW_MS = 180_000;
const MIN_SPACING_MS = 5_000;

/**
 * Parse the aggregate `cpu ` line of /proc/stat into { busy, iowait, total }.
 * Columns: user nice system idle iowait irq softirq steal guest guest_nice.
 * Only the first 8 count (guest time is already inside user).
 * - iowait is not busy: the CPU is idle during it and the load gate judges CPU
 *   only. Swap-in waits land there on this host, and the memory gate and swap
 *   clamp run before the load gate. It is carried as its own figure. os.cpus()
 *   has no such column, so macOS matches.
 * - nice counts as busy: every Session Manager process here runs at nice 12,
 *   so nice is the largest column on this box.
 * @param {string} text
 * @returns {{ busy: number, iowait: number, total: number } | null}
 */
function parseProcStat(text) {
  if (typeof text !== 'string' || !text) return null;
  const line = text.split('\n').find((l) => l.startsWith('cpu '));
  if (!line) return null;
  const parts = line.trim().split(/\s+/).slice(1, 9);
  if (parts.length < 4) return null;
  const nums = [];
  for (const p of parts) {
    const n = Number(p);
    if (!Number.isFinite(n)) return null;
    nums.push(n);
  }
  while (nums.length < 8) nums.push(0);
  const total = nums.reduce((a, b) => a + b, 0);
  const idle = nums[3];
  const iowait = nums[4];
  return { busy: total - idle - iowait, iowait, total };
}

/**
 * @param {{ platform?: string, readFile?: (p: string) => string, cpus?: () => import('node:os').CpuInfo[] }} [deps]
 * @returns {{ busy: number, iowait: number, total: number } | null}
 */
function readCpuTimes({
  platform = process.platform,
  readFile = (p) => fs.readFileSync(p, 'utf8'),
  cpus = () => os.cpus(),
} = {}) {
  try {
    if (platform === 'linux') return parseProcStat(readFile('/proc/stat'));
    const list = cpus();
    if (!Array.isArray(list) || list.length === 0) return null;
    let busy = 0;
    let idle = 0;
    for (const c of list) {
      const t = c.times;
      busy += t.user + t.nice + t.sys + t.irq;
      idle += t.idle;
    }
    if (![busy, idle].every(Number.isFinite)) return null;
    return { busy, iowait: 0, total: busy + idle };
  } catch {
    return null;
  }
}

/**
 * Parse one /proc/<pid>/stat line → { pid, ppid, ticks: utime+stime }.
 * comm (field 2) may contain spaces and parens, so split after the LAST ')'.
 * @param {string} text
 * @returns {{ pid: number, ppid: number, ticks: number } | null}
 */
function parsePidStat(text) {
  if (typeof text !== 'string' || !text) return null;
  const close = text.lastIndexOf(')');
  const open = text.indexOf('(');
  if (close < 0 || open < 0) return null;
  const pid = Number(text.slice(0, open).trim());
  // After ')': state(3) ppid(4) ... utime(14) stime(15) → indices 0,1,...,11,12.
  const rest = text.slice(close + 1).trim().split(/\s+/);
  const ppid = Number(rest[1]);
  const utime = Number(rest[11]);
  const stime = Number(rest[12]);
  if (![pid, ppid, utime, stime].every(Number.isFinite)) return null;
  return { pid, ppid, ticks: utime + stime };
}

/**
 * True when a /proc/<pid>/cmdline names an Electron/Chromium helper: `--type=`
 * among the first two arguments. Chromium helpers rewrite their argv into one
 * space-joined string (setproctitle), so split on NUL and space.
 * @param {string} cmd
 */
function isElectronHelperCmdline(cmd) {
  if (typeof cmd !== 'string') return false;
  return cmd.split(/[\0 ]+/).slice(1, 3).some((a) => a.startsWith('--type='));
}

/**
 * The app's own process tree as Map<pid, cumulative utime+stime ticks>: the
 * root (Electron main) plus every descendant reached only through processes
 * whose cmdline carries an Electron `--type=` flag. Linux only; null elsewhere
 * or when /proc cannot be listed. Never throws.
 * A helper must also run the same executable as the root (when /proc/<pid>/exe
 * is readable), so a job whose prompt text happens to contain "--type=" never
 * counts as own.
 * @param {{ rootPid?: number, platform?: string, readdir?: (p: string) => string[],
 *   readFile?: (p: string) => string, readlink?: (p: string) => string }} [deps]
 * @returns {Map<number, number> | null}
 */
function readOwnProcessTicks({
  rootPid = process.pid,
  platform = process.platform,
  readdir = (p) => fs.readdirSync(p),
  readFile = (p) => fs.readFileSync(p, 'utf8'),
  readlink = (p) => fs.readlinkSync(p),
} = {}) {
  if (platform !== 'linux') return null;
  try {
    /** @type {Map<number, { ppid: number, ticks: number }>} */
    const procs = new Map();
    /** @type {Map<number, number[]>} */
    const children = new Map();
    for (const name of readdir('/proc')) {
      if (!/^\d+$/.test(name)) continue;
      let st;
      try { st = parsePidStat(readFile(`/proc/${name}/stat`)); } catch { continue; }
      if (!st) continue;
      procs.set(st.pid, { ppid: st.ppid, ticks: st.ticks });
      const list = children.get(st.ppid);
      if (list) list.push(st.pid); else children.set(st.ppid, [st.pid]);
    }
    const root = procs.get(rootPid);
    if (!root) return null;
    const exeOf = (/** @type {number} */ pid) => { try { return readlink(`/proc/${pid}/exe`); } catch { return null; } };
    const rootExe = exeOf(rootPid);
    /** @type {Map<number, number>} */
    const own = new Map([[rootPid, root.ticks]]);
    const queue = [rootPid];
    while (queue.length) {
      const parent = /** @type {number} */ (queue.shift());
      for (const child of children.get(parent) || []) {
        let cmd = '';
        try { cmd = readFile(`/proc/${child}/cmdline`); } catch { continue; }
        if (!isElectronHelperCmdline(cmd)) continue;
        if (rootExe !== null && exeOf(child) !== rootExe) continue;
        own.set(child, /** @type {{ticks:number}} */ (procs.get(child)).ticks);
        queue.push(child);
      }
    }
    return own;
  } catch {
    return null;
  }
}

/**
 * Own-process ticks consumed between two readings. A pid only in `before`
 * exited (its last ticks are lost, count 0); a pid only in `after` started in
 * the window, so all its ticks count.
 * @param {Map<number, number> | null} before
 * @param {Map<number, number> | null} after
 * @returns {number | null}
 */
function ownTicksDelta(before, after) {
  if (!before || !after) return null;
  let d = 0;
  for (const [pid, ticks] of after) {
    const prev = before.get(pid);
    d += prev === undefined ? ticks : Math.max(0, ticks - prev);
  }
  return d;
}

/**
 * @param {{ read?: () => ({busy:number,iowait?:number,total:number}|null),
 *   readOwn?: () => (Map<number, number>|null), now?: () => number,
 *   windowMs?: number, minWindowMs?: number, maxWindowMs?: number, minSpacingMs?: number }} [opts]
 */
function createCpuSampler({
  read = readCpuTimes,
  readOwn = () => readOwnProcessTicks(),
  now = () => Date.now(),
  windowMs = DEFAULT_WINDOW_MS,
  minWindowMs = MIN_WINDOW_MS,
  maxWindowMs = MAX_WINDOW_MS,
  minSpacingMs = MIN_SPACING_MS,
} = {}) {
  /** @type {{ at: number, busy: number, iowait: number, total: number, own: Map<number, number> | null }[]} */
  let entries = [];

  function observe() {
    const t = now();
    const r = read();
    if (!r) return;
    const newest = entries[entries.length - 1];
    if (newest && t - newest.at < minSpacingMs) return;
    entries.push({ at: t, busy: r.busy, iowait: r.iowait ?? 0, total: r.total, own: readOwn() });
    entries = entries.filter((e) => t - e.at <= maxWindowMs);
  }

  function sample() {
    const t = now();
    const r = read();
    if (!r) return null;
    let best = null;
    let bestDiff = Infinity;
    for (const e of entries) {
      const age = t - e.at;
      if (age < minWindowMs || age > maxWindowMs) continue;
      const diff = Math.abs(age - windowMs);
      if (diff < bestDiff) {
        best = e;
        bestDiff = diff;
      }
    }
    if (!best) return null;
    const dBusy = r.busy - best.busy;
    const dTotal = r.total - best.total;
    const dIowait = (r.iowait ?? 0) - best.iowait;
    // Per-CPU idle and iowait counters can step backwards.
    if (dTotal <= 0 || dBusy < 0) return null;
    const dOwnRaw = ownTicksDelta(best.own, readOwn());
    const dOwn = dOwnRaw === null ? null : Math.min(dBusy, dOwnRaw);
    return {
      busyFraction: Math.min(1, dBusy / dTotal),
      ownFraction: dOwn === null ? null : dOwn / dTotal,
      netBusyFraction: Math.min(1, (dBusy - (dOwn ?? 0)) / dTotal),
      iowaitFraction: Math.min(1, Math.max(0, dIowait / dTotal)),
      windowMs: t - best.at,
    };
  }

  return { observe, sample };
}

module.exports = {
  parseProcStat,
  parsePidStat,
  readOwnProcessTicks,
  ownTicksDelta,
  readCpuTimes,
  createCpuSampler,
  DEFAULT_WINDOW_MS,
  MIN_WINDOW_MS,
  MAX_WINDOW_MS,
  MIN_SPACING_MS,
};

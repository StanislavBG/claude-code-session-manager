'use strict';

/**
 * leftoverRenice.cjs — lower leftover chat/aux tool processes to idle priority.
 *
 * 2026-11-23: a Chatterbox voice render started by a one-shot Burrow chat turn
 * kept running after the turn ended (its `claude` process gone, parent bash
 * reparented to pid 1) and used 8 cores for 40+ minutes at the app's nice 12,
 * so the CPU load gate held every scheduler job. Evidence: pid 2893850
 * `/tmp/cbtest/bin/python /tmp/cb-script/takes.py`, SM_PROC_ROLE=chat,
 * CLAUDE_PID=2858266 (gone).
 *
 * A leftover = a process of THIS user whose environment carries
 * SM_PROC_ROLE=chat|aux AND a CLAUDE_PID whose process no longer exists. Such a
 * process is set to nice 19 (never killed — its output may be wanted); the CPU
 * sampler (cpuSample.cjs, PRD 4021) then stops counting it as load.
 *
 * - A process with no CLAUDE_PID (e.g. the chat's own `claude`) is never a
 *   leftover: there is no turn to judge it by.
 * - Raising one's own process niceness needs no privileges; lowering it would.
 * - A process whose CLAUDE_PID equals the one the app itself inherited at
 *   startup (app launched from inside a claude session) is never a leftover:
 *   every chat process carries that value, so it says nothing about the turn.
 * - Only /proc/<pid>/status (Uid) and /proc/<pid>/environ are read; from
 *   environ only SM_PROC_ROLE and CLAUDE_PID are kept.
 * - A scan reads at most MAX_SCAN pids, skips unreadable entries, never throws,
 *   and never sends a signal.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pidAlive } = require('./pidAlive.cjs');

const MAX_SCAN = 4000;
const IDLE_NICE = 19;
const LEFTOVER_ROLES = new Set(['chat', 'aux']);

/** CLAUDE_PID the app main process inherited, read once at module load. */
const APP_CLAUDE_PID = parseEnviron(`CLAUDE_PID=${process.env.CLAUDE_PID ?? ''}`).claudePid;

/**
 * Pick SM_PROC_ROLE and CLAUDE_PID out of NUL-separated environ text.
 * @param {string} text
 * @returns {{ role: string | null, claudePid: number | null }}
 */
function parseEnviron(text) {
  let role = null;
  let claudePid = null;
  if (typeof text !== 'string') return { role, claudePid };
  for (const entry of text.split('\0')) {
    if (entry.startsWith('SM_PROC_ROLE=')) role = entry.slice('SM_PROC_ROLE='.length);
    else if (entry.startsWith('CLAUDE_PID=')) {
      const raw = entry.slice('CLAUDE_PID='.length);
      const n = /^\d+$/.test(raw) ? Number(raw) : NaN;
      claudePid = Number.isInteger(n) ? n : null;
    }
  }
  return { role, claudePid };
}

/**
 * Real uid from /proc/<pid>/status text, or null.
 * @param {string} text
 */
function parseStatusUid(text) {
  if (typeof text !== 'string') return null;
  const m = /^Uid:\s+(\d+)/m.exec(text);
  return m ? Number(m[1]) : null;
}

function currentUid() {
  return typeof process.getuid === 'function' ? process.getuid() : null;
}

/**
 * Leftover processes (see header). Never throws; [] off Linux-like hosts.
 * @param {{ procRoot?: string, uid?: number | null, maxPids?: number,
 *   readdir?: (p: string) => string[], readFile?: (p: string) => string,
 *   isAlive?: (pid: number) => boolean, selfPid?: number,
 *   appClaudePid?: number | null }} [opts]
 * @returns {{ pid: number, role: string, claudePid: number }[]}
 */
function findLeftovers({
  procRoot = '/proc',
  uid = currentUid(),
  maxPids = MAX_SCAN,
  readdir = (p) => fs.readdirSync(p),
  readFile = (p) => fs.readFileSync(p, 'latin1'),
  isAlive,
  selfPid = process.pid,
  appClaudePid = APP_CLAUDE_PID,
} = {}) {
  if (uid === null || uid === undefined) return [];
  // Under an injected tree a pid is alive when its directory exists there.
  const alive = isAlive || (procRoot === '/proc'
    ? pidAlive
    : (/** @type {number} */ pid) => {
      try { return fs.existsSync(path.join(procRoot, String(pid))); } catch { return false; }
    });
  /** @type {{ pid: number, role: string, claudePid: number }[]} */
  const out = [];
  let names;
  try { names = readdir(procRoot); } catch { return out; }
  if (!Array.isArray(names)) return out;
  let scanned = 0;
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    if (scanned >= maxPids) break;
    scanned += 1;
    const pid = Number(name);
    if (pid === selfPid || pid <= 1) continue;
    try {
      if (parseStatusUid(readFile(path.join(procRoot, name, 'status'))) !== uid) continue;
      const { role, claudePid } = parseEnviron(readFile(path.join(procRoot, name, 'environ')));
      if (!role || !LEFTOVER_ROLES.has(role)) continue;
      if (claudePid === null || claudePid <= 1) continue;
      if (appClaudePid !== null && appClaudePid !== undefined && claudePid === appClaudePid) continue;
      if (alive(claudePid)) continue;
      out.push({ pid, role, claudePid });
    } catch {
      // Unreadable or vanished entry: skip it.
    }
  }
  return out;
}

/** Pids already logged, so each leftover is reported once. */
const logged = new Set();

/**
 * Set every leftover to nice 19 and log each pid once. Never throws, never
 * sends a signal. Returns the pids reniced this call.
 * @param {Parameters<typeof findLeftovers>[0] & {
 *   setPriority?: (pid: number, prio: number) => void,
 *   getPriority?: (pid: number) => number,
 *   log?: (msg: string) => void, seen?: Set<number> }} [opts]
 * @returns {number[]}
 */
function reniceLeftovers(opts = {}) {
  const {
    setPriority = (pid, prio) => os.setPriority(pid, prio),
    getPriority = (pid) => os.getPriority(pid),
    log = (msg) => console.log(msg),
    seen = logged,
    ...findOpts
  } = opts;
  /** @type {number[]} */
  const done = [];
  try {
    const leftovers = findLeftovers(findOpts);
    const current = new Set();
    for (const l of leftovers) {
      current.add(l.pid);
      try {
        let prio = null;
        try { prio = getPriority(l.pid); } catch { prio = null; }
        if (prio !== IDLE_NICE) {
          setPriority(l.pid, IDLE_NICE);
          done.push(l.pid);
        }
        if (!seen.has(l.pid)) {
          seen.add(l.pid);
          log(`[leftoverRenice] pid ${l.pid} (SM_PROC_ROLE=${l.role}, CLAUDE_PID ${l.claudePid} gone) set to nice ${IDLE_NICE}`);
        }
      } catch {
        // Vanished, or not ours after all: leave it.
      }
    }
    // Forget pids that are no longer leftovers so a reused pid logs again.
    for (const pid of seen) if (!current.has(pid)) seen.delete(pid);
  } catch {
    // Never throws.
  }
  return done;
}

module.exports = { findLeftovers, APP_CLAUDE_PID, reniceLeftovers, parseEnviron, parseStatusUid, MAX_SCAN, IDLE_NICE };

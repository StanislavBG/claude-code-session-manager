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
 *
 * Idle-priority exclusion (PRD 4021): 2026-11-23 6:20 PM PST the gate held all
 * 163 pending jobs with 0 running while two local voice renders used ~13.5 of
 * 14 cores; one ran at nice 19. A nice-19 process yields to anything at a
 * higher priority, jobs included, so it is not load the gate should defend.
 * The same bounded /proc scan that finds the own tree also collects every
 * process at nice 19 (field 19 of /proc/<pid>/stat) that is not an own
 * process; its ticks are subtracted from the net figure and reported as
 * idleNiceShare. Nice 12 and below still count as busy.
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
// One /proc scan reads at most this many pids, so a pid-storm host cannot turn
// a sample into thousands of file reads every tick.
const MAX_PROC_SCAN = 4096;
// The lowest scheduling priority Linux offers: such a process only gets CPU
// time no one else wants.
const IDLE_NICE = 19;

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
 * Parse one /proc/<pid>/stat line → { pid, ppid, ticks: utime+stime, nice }.
 * comm (field 2) may contain spaces and parens, so split after the LAST ')'.
 * nice is null when the line is too short to carry field 19.
 * @param {string} text
 * @returns {{ pid: number, ppid: number, ticks: number, nice: number | null } | null}
 */
function parsePidStatFields(text) {
  if (typeof text !== 'string' || !text) return null;
  const close = text.lastIndexOf(')');
  const open = text.indexOf('(');
  if (close < 0 || open < 0) return null;
  const pid = Number(text.slice(0, open).trim());
  // After ')': state(3) ppid(4) ... utime(14) stime(15) ... nice(19) → indices 0,1,...,11,12,...,16.
  const rest = text.slice(close + 1).trim().split(/\s+/);
  const ppid = Number(rest[1]);
  const utime = Number(rest[11]);
  const stime = Number(rest[12]);
  if (![pid, ppid, utime, stime].every(Number.isFinite)) return null;
  const nice = rest.length > 16 && rest[16] !== '' ? Number(rest[16]) : NaN;
  return { pid, ppid, ticks: utime + stime, nice: Number.isFinite(nice) ? nice : null };
}

/**
 * Parse one /proc/<pid>/stat line → { pid, ppid, ticks: utime+stime }.
 * @param {string} text
 * @returns {{ pid: number, ppid: number, ticks: number } | null}
 */
function parsePidStat(text) {
  const f = parsePidStatFields(text);
  return f ? { pid: f.pid, ppid: f.ppid, ticks: f.ticks } : null;
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
 * One bounded /proc scan (at most maxPids pids) → { own, idleNice }.
 * - own: the app's own process tree as Map<pid, cumulative utime+stime ticks>:
 *   the root (Electron main) plus every descendant reached only through
 *   processes whose cmdline carries an Electron `--type=` flag. A helper must
 *   also run the same executable as the root (when /proc/<pid>/exe is
 *   readable), so a job whose prompt text happens to contain "--type=" never
 *   counts as own. null when the root is not in the scan.
 * - idleNice: Map<pid, ticks> of every process at nice 19 that is not own
 *   (own ticks are already subtracted, so they never count twice).
 * Linux only; both null elsewhere or when /proc cannot be listed. Never throws.
 * @param {{ rootPid?: number, platform?: string, readdir?: (p: string) => string[],
 *   readFile?: (p: string) => string, readlink?: (p: string) => string, maxPids?: number }} [deps]
 * @returns {{ own: Map<number, number> | null, idleNice: Map<number, number> | null }}
 */
function readProcessTicks({
  rootPid = process.pid,
  platform = process.platform,
  readdir = (p) => fs.readdirSync(p),
  readFile = (p) => fs.readFileSync(p, 'utf8'),
  readlink = (p) => fs.readlinkSync(p),
  maxPids = MAX_PROC_SCAN,
} = {}) {
  if (platform !== 'linux') return { own: null, idleNice: null };
  try {
    /** @type {Map<number, { ppid: number, ticks: number, nice: number | null }>} */
    const procs = new Map();
    /** @type {Map<number, number[]>} */
    const children = new Map();
    let scanned = 0;
    for (const name of readdir('/proc')) {
      if (!/^\d+$/.test(name)) continue;
      if (scanned >= maxPids) break;
      scanned += 1;
      let st;
      try { st = parsePidStatFields(readFile(`/proc/${name}/stat`)); } catch { continue; }
      if (!st) continue;
      procs.set(st.pid, { ppid: st.ppid, ticks: st.ticks, nice: st.nice });
      const list = children.get(st.ppid);
      if (list) list.push(st.pid); else children.set(st.ppid, [st.pid]);
    }
    /** @type {Map<number, number> | null} */
    let own = null;
    const root = procs.get(rootPid);
    if (root) {
      const exeOf = (/** @type {number} */ pid) => { try { return readlink(`/proc/${pid}/exe`); } catch { return null; } };
      const rootExe = exeOf(rootPid);
      own = new Map([[rootPid, root.ticks]]);
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
    }
    /** @type {Map<number, number>} */
    const idleNice = new Map();
    for (const [pid, p] of procs) {
      if (p.nice === IDLE_NICE && !(own && own.has(pid))) idleNice.set(pid, p.ticks);
    }
    return { own, idleNice };
  } catch {
    return { own: null, idleNice: null };
  }
}

/**
 * The app's own process tree (see readProcessTicks). Linux only; null
 * elsewhere, when /proc cannot be listed, or when the root is not found.
 * @param {Parameters<typeof readProcessTicks>[0]} [deps]
 * @returns {Map<number, number> | null}
 */
function readOwnProcessTicks(deps) {
  return readProcessTicks(deps).own;
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
 * Nice-19 ticks consumed between two readings, counting only pids at nice 19
 * in BOTH. Unlike own processes, a pid absent from `before` may have run the
 * whole window at a higher priority and only now been reniced (its cumulative
 * ticks would then wipe out real load), so it waits for the next window. Erring
 * that way keeps the gate holding rather than launching onto a busy CPU.
 * @param {Map<number, number> | null} before
 * @param {Map<number, number> | null} after
 * @returns {number | null}
 */
function idleNiceTicksDelta(before, after) {
  if (!before || !after) return null;
  let d = 0;
  for (const [pid, ticks] of after) {
    const prev = before.get(pid);
    if (prev !== undefined) d += Math.max(0, ticks - prev);
  }
  return d;
}

/**
 * `readProcs` returns { own, idleNice } from one /proc scan (default
 * readProcessTicks). Injecting `readOwn` and/or `readIdleNice` instead builds
 * it from those (a missing one reads null).
 * @param {{ read?: () => ({busy:number,iowait?:number,total:number}|null),
 *   readProcs?: () => ({ own: Map<number, number>|null, idleNice: Map<number, number>|null }),
 *   readOwn?: () => (Map<number, number>|null), readIdleNice?: () => (Map<number, number>|null),
 *   now?: () => number,
 *   windowMs?: number, minWindowMs?: number, maxWindowMs?: number, minSpacingMs?: number }} [opts]
 */
function createCpuSampler({
  read = readCpuTimes,
  readOwn,
  readIdleNice,
  readProcs = (readOwn || readIdleNice)
    ? () => ({ own: readOwn ? readOwn() : null, idleNice: readIdleNice ? readIdleNice() : null })
    : () => readProcessTicks(),
  now = () => Date.now(),
  windowMs = DEFAULT_WINDOW_MS,
  minWindowMs = MIN_WINDOW_MS,
  maxWindowMs = MAX_WINDOW_MS,
  minSpacingMs = MIN_SPACING_MS,
} = {}) {
  /** @type {{ at: number, busy: number, iowait: number, total: number, own: Map<number, number> | null, idleNice: Map<number, number> | null }[]} */
  let entries = [];

  function observe() {
    const t = now();
    const r = read();
    if (!r) return;
    const newest = entries[entries.length - 1];
    if (newest && t - newest.at < minSpacingMs) return;
    const p = readProcs() || { own: null, idleNice: null };
    entries.push({ at: t, busy: r.busy, iowait: r.iowait ?? 0, total: r.total, own: p.own ?? null, idleNice: p.idleNice ?? null });
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
    const p = readProcs() || { own: null, idleNice: null };
    const dOwnRaw = ownTicksDelta(best.own, p.own ?? null);
    const dOwn = dOwnRaw === null ? null : Math.min(dBusy, dOwnRaw);
    // Clamped so net never drops below 0.
    const dIdleRaw = idleNiceTicksDelta(best.idleNice, p.idleNice ?? null);
    const dIdle = dIdleRaw === null ? null : Math.min(dBusy - (dOwn ?? 0), dIdleRaw);
    return {
      busyFraction: Math.min(1, dBusy / dTotal),
      ownFraction: dOwn === null ? null : dOwn / dTotal,
      idleNiceShare: dIdle === null ? null : dIdle / dTotal,
      netBusyFraction: Math.min(1, (dBusy - (dOwn ?? 0) - (dIdle ?? 0)) / dTotal),
      iowaitFraction: Math.min(1, Math.max(0, dIowait / dTotal)),
      windowMs: t - best.at,
    };
  }

  return { observe, sample };
}

module.exports = {
  parseProcStat,
  parsePidStat,
  parsePidStatFields,
  readProcessTicks,
  readOwnProcessTicks,
  ownTicksDelta,
  idleNiceTicksDelta,
  readCpuTimes,
  createCpuSampler,
  DEFAULT_WINDOW_MS,
  MIN_WINDOW_MS,
  MAX_WINDOW_MS,
  MIN_SPACING_MS,
  MAX_PROC_SCAN,
  IDLE_NICE,
};

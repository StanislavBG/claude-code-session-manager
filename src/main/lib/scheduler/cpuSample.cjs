'use strict';

/**
 * cpuSample.cjs — measured machine-wide CPU use over a real window.
 *
 * The 1-minute load average counts parked D-state tasks and short bursts, so
 * it can read high on a mostly idle machine (2026-11-01, 14 CPUs: 25 D-state
 * tasks gave loadavg1 22.39 while the CPU was only 24% busy over 75 s). This
 * helper derives busy/total from cumulative counters over a window of about a
 * minute instead. Pure and injectable (`read`, `now`); nothing calls it yet.
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
 * Parse the aggregate `cpu ` line of /proc/stat into { busy, total }.
 * Columns: user nice system idle iowait irq softirq steal guest guest_nice.
 * Only the first 8 count (guest time is already inside user).
 * - iowait counts as busy: a disk-saturated machine keeps holding launches;
 *   only true idle may open the gate.
 * - nice counts as busy: every Session Manager process here runs at nice 12,
 *   so nice is the largest column on this box.
 * @param {string} text
 * @returns {{ busy: number, total: number } | null}
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
  return { busy: total - nums[3], total };
}

/**
 * @param {{ platform?: string, readFile?: (p: string) => string, cpus?: () => import('node:os').CpuInfo[] }} [deps]
 * @returns {{ busy: number, total: number } | null}
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
    return { busy, total: busy + idle };
  } catch {
    return null;
  }
}

/**
 * @param {{ read?: () => ({busy:number,total:number}|null), now?: () => number,
 *   windowMs?: number, minWindowMs?: number, maxWindowMs?: number, minSpacingMs?: number }} [opts]
 */
function createCpuSampler({
  read = readCpuTimes,
  now = () => Date.now(),
  windowMs = DEFAULT_WINDOW_MS,
  minWindowMs = MIN_WINDOW_MS,
  maxWindowMs = MAX_WINDOW_MS,
  minSpacingMs = MIN_SPACING_MS,
} = {}) {
  /** @type {{ at: number, busy: number, total: number }[]} */
  let entries = [];

  function observe() {
    const t = now();
    const r = read();
    if (!r) return;
    const newest = entries[entries.length - 1];
    if (newest && t - newest.at < minSpacingMs) return;
    entries.push({ at: t, busy: r.busy, total: r.total });
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
    // Per-CPU idle and iowait counters can step backwards.
    if (dTotal <= 0 || dBusy < 0) return null;
    return { busyFraction: Math.min(1, dBusy / dTotal), windowMs: t - best.at };
  }

  return { observe, sample };
}

module.exports = {
  parseProcStat,
  readCpuTimes,
  createCpuSampler,
  DEFAULT_WINDOW_MS,
  MIN_WINDOW_MS,
  MAX_WINDOW_MS,
  MIN_SPACING_MS,
};

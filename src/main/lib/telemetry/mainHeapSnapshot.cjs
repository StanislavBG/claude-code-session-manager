/**
 * mainHeapSnapshot.cjs — bounded, automatic V8 heap snapshot of the MAIN process.
 * Captures at most once per process when heapUsed crosses a threshold, keeps at
 * most 2 `main-heap-*.heapsnapshot` files, and refuses when disk is tight.
 * Synchronous (v8.writeHeapSnapshot) — acceptable once per boot for diagnosis.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_THRESHOLD_MB = 1800;
const KEEP = 2;
const PREFIX = 'main-heap-';
const SUFFIX = '.heapsnapshot';

const defaultState = { captured: false };

function resolveThreshold(thresholdMb) {
  if (Number.isFinite(thresholdMb) && thresholdMb > 0) return thresholdMb;
  const env = Number(process.env.SM_MAIN_HEAP_SNAPSHOT_MB);
  return Number.isFinite(env) && env > 0 ? env : DEFAULT_THRESHOLD_MB;
}

function pruneOld(dir, keep) {
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => n.startsWith(PREFIX) && n.endsWith(SUFFIX)); } catch { return; }
  // ISO timestamps sort lexically; oldest first.
  names.sort();
  for (const n of names.slice(0, Math.max(0, names.length - keep))) {
    try { fs.unlinkSync(path.join(dir, n)); } catch { /* best-effort */ }
  }
}

/**
 * @param {{ heapUsedMb:number, thresholdMb?:number, dir?:string, now?:Date,
 *   writeFn?:(p:string)=>any, statfsFn?:Function, state?:{captured:boolean} }} opts
 * @returns {{ captured:boolean, filePath?:string, reason?:string }}
 */
function maybeCaptureMainHeap(opts = {}) {
  const state = opts.state || defaultState;
  if (process.env.SM_MAIN_HEAP_SNAPSHOT === '0') return { captured: false, reason: 'disabled' };
  if (state.captured) return { captured: false, reason: 'already-captured' };
  const heapUsedMb = Number(opts.heapUsedMb);
  if (!Number.isFinite(heapUsedMb) || heapUsedMb < resolveThreshold(opts.thresholdMb)) {
    return { captured: false, reason: 'below-threshold' };
  }
  const dir = opts.dir || require('../scheduler/schedulerPaths.cjs').heapSnapshotDir();
  const writeFn = opts.writeFn || ((p) => require('node:v8').writeHeapSnapshot(p));
  const statfsFn = opts.statfsFn || fs.statfsSync;
  const now = opts.now instanceof Date ? opts.now : new Date();
  try {
    fs.mkdirSync(dir, { recursive: true });
    const st = statfsFn(dir);
    const freeMb = (Number(st.bavail) * Number(st.bsize)) / 1048576;
    if (!(freeMb >= 3 * heapUsedMb)) return { captured: false, reason: 'low-disk' };
    // Leave room for the new file: keep KEEP-1 old ones, so KEEP remain after the write.
    pruneOld(dir, KEEP - 1);
    state.captured = true;
    const filePath = path.join(dir, `${PREFIX}${now.toISOString().replace(/[:.]/g, '-')}${SUFFIX}`);
    writeFn(filePath);
    return { captured: true, filePath };
  } catch (err) {
    return { captured: false, reason: `error: ${err && err.message}` };
  }
}

module.exports = { maybeCaptureMainHeap, DEFAULT_THRESHOLD_MB };

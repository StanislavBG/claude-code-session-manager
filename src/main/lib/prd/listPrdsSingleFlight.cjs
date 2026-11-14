/**
 * listPrdsSingleFlight.cjs — single-flight wrapper + string flattening for
 * scheduler.cjs's listPrdsInternal() (PRD 3063).
 *
 * Why: the 2026-11-08 main-process heap snapshot held ~21 overlapping
 * machine-wide `schedule:list-prds` scans at once; 1.62 GB of the 1.75 GB
 * live heap was PRD file text kept alive by V8 sliced strings (title,
 * dependsOn, ...) that each scan's entries pointed into. Two fixes live here:
 *
 *  - createSingleFlight(fn, keyOf): concurrent calls with the same key share
 *    ONE in-flight promise; the slot clears when it settles (resolve OR
 *    reject), so the next call starts a fresh scan / retries a failure.
 *  - flatString / flattenPrdEntry: copy every string that came from file text
 *    into a fresh flat string, so an entry never retains the parsed file.
 *
 * Pure — no fs, no electron — so it is unit-testable under vitest.
 */
'use strict';

const MACHINE_WIDE_KEY = '*';

/**
 * @param {(arg: any) => Promise<any>} fn
 * @param {(arg: any) => string} keyOf
 */
function createSingleFlight(fn, keyOf) {
  const inFlight = new Map();
  function shared(arg) {
    const key = keyOf(arg);
    const existing = inFlight.get(key);
    if (existing) return existing;
    // fn may throw synchronously; the async IIFE turns that into a rejection.
    const p = (async () => fn(arg))();
    inFlight.set(key, p);
    // Clear AFTER set (a sync throw would otherwise run cleanup before the
    // slot exists and strand a rejected promise in it). Registered before any
    // caller's await, so the slot is gone by the time a caller resumes.
    const clear = () => { if (inFlight.get(key) === p) inFlight.delete(key); };
    p.then(clear, clear);
    return p;
  }
  shared.inFlight = inFlight;
  return shared;
}

/** Key for a list-prds call: normalized non-empty cwd, else the machine-wide key. */
function listKeyFor(cwd) {
  return typeof cwd === 'string' && cwd.length > 0 ? cwd : MACHINE_WIDE_KEY;
}

/**
 * Return a flat copy of `s` that shares no backing store with its parent
 * (a Buffer round-trip always materializes a new sequential string).
 * Non-strings pass through untouched.
 */
function flatString(s) {
  if (typeof s !== 'string') return s;
  if (s.length === 0) return '';
  return Buffer.from(s, 'utf8').toString('utf8');
}

/** Flatten every string field, and every string item of every array field, in place. */
function flattenPrdEntry(entry) {
  if (!entry || typeof entry !== 'object') return entry;
  for (const k of Object.keys(entry)) {
    const v = entry[k];
    if (typeof v === 'string') entry[k] = flatString(v);
    else if (Array.isArray(v)) entry[k] = v.map((x) => flatString(x));
  }
  return entry;
}

module.exports = {
  MACHINE_WIDE_KEY,
  createSingleFlight,
  listKeyFor,
  flatString,
  flattenPrdEntry,
};

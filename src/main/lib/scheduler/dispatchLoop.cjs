'use strict';

/**
 * dispatchLoop.cjs — dispatch's own periodic driver. Cadence is owned here and
 * nothing else can degrade it: no billing backoff, utilization, fire policy or
 * cancel token is read. It only calls the injected `tick` (scheduler's
 * tickQueue, which funnels through sessionSlots/pickNextBatch).
 */

const RECONCILE_INTERVAL_MS = 30_000;
const MIN_INTERVAL_MS = 10_000;
const MAX_INTERVAL_MS = 300_000;

/** Pure: env override (SM_DISPATCH_LOOP_INTERVAL_MS) or explicit value, clamped to [10s, 300s]. */
function resolveIntervalMs(intervalMs, env = process.env) {
  const raw = intervalMs ?? env.SM_DISPATCH_LOOP_INTERVAL_MS;
  const n = Number(raw);
  if (raw === undefined || raw === null || raw === '' || !Number.isFinite(n)) return RECONCILE_INTERVAL_MS;
  return Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, Math.floor(n)));
}

/**
 * @param {{ tick: () => any, intervalMs?: number, onError?: (e: Error) => void }} opts
 * @returns {{ stop: () => void }}
 */
function startDispatchLoop({ tick, intervalMs, onError } = {}) {
  if (typeof tick !== 'function') throw new TypeError('startDispatchLoop: tick must be a function');
  if (process.env.SM_DISPATCH_LOOP_DISABLE === '1') return { stop() {} };
  let running = false;
  const report = (e) => { try { if (onError) onError(e); } catch { /* reporting must not throw */ } };
  const timer = setInterval(async () => {
    if (running) return; // previous pass still in flight — no pile-up
    running = true;
    try { await tick(); } catch (e) { report(e); } finally { running = false; }
  }, resolveIntervalMs(intervalMs));
  if (timer.unref) timer.unref();
  return { stop() { clearInterval(timer); } };
}

module.exports = { startDispatchLoop, resolveIntervalMs, RECONCILE_INTERVAL_MS, MIN_INTERVAL_MS, MAX_INTERVAL_MS };

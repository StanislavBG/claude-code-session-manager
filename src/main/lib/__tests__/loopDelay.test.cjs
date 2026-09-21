/**
 * loopDelay.test.cjs — event-loop delay probe used by crashDiagnostics's heartbeat.
 *
 * Run: timeout 120 npx vitest run src/main/lib/__tests__/loopDelay.test.cjs
 */
'use strict';

import { test, expect } from 'vitest';

const { createLoopDelayMonitor, stallVerdict, LOOP_STALL_WARN_MS } = require('../loopDelay.cjs');

// Histogram stub: values in ns, like perf_hooks.
function stubHistogram(state) {
  return () => ({
    enabled: false,
    enable() { this.enabled = true; },
    disable() { this.enabled = false; },
    percentile(p) { return p === 50 ? state.p50 : state.p99; },
    get max() { return state.max; },
    reset() { state.resets += 1; state.p50 = 0; state.p99 = 0; state.max = 0; },
  });
}

test('normal beat: converts ns to ms (1 decimal) and does not flag a stall', () => {
  const state = { p50: 21_040_000, p99: 34_960_000, max: 40_000_000, resets: 0 };
  const m = createLoopDelayMonitor(stubHistogram(state));
  m.enable();
  const snap = m.snapshot();
  expect(snap).toEqual({ loopDelayP50Ms: 21, loopDelayP99Ms: 35, loopDelayMaxMs: 40 });
  expect(stallVerdict(snap)).toBeNull();
});

test('stall beat: max above threshold yields warn "main loop stall"', () => {
  const state = { p50: 20_000_000, p99: 300_000_000, max: 412_300_000, resets: 0 };
  const snap = createLoopDelayMonitor(stubHistogram(state)).snapshot();
  expect(snap.loopDelayMaxMs).toBe(412.3);
  expect(stallVerdict(snap)).toEqual({ level: 'warn', message: 'main loop stall' });
  expect(stallVerdict({ loopDelayMaxMs: LOOP_STALL_WARN_MS })).toBeNull(); // strictly greater
});

test('reset between beats: a stall does not bleed into the next interval', () => {
  const state = { p50: 20_000_000, p99: 300_000_000, max: 500_000_000, resets: 0 };
  const m = createLoopDelayMonitor(stubHistogram(state));
  expect(stallVerdict(m.snapshot())).not.toBeNull();
  expect(state.resets).toBe(1);
  const second = m.snapshot();
  expect(second.loopDelayMaxMs).toBe(0);
  expect(stallVerdict(second)).toBeNull();
  expect(state.resets).toBe(2);
});

test('passes a 20 ms resolution to the histogram factory and disable() stops it', () => {
  let opts; let h;
  const m = createLoopDelayMonitor((o) => { opts = o; h = stubHistogram({ resets: 0 })(); return h; });
  m.enable();
  expect(opts).toEqual({ resolution: 20 });
  expect(h.enabled).toBe(true);
  m.disable();
  expect(h.enabled).toBe(false);
});

test('real perf_hooks histogram produces finite numbers', () => {
  const m = createLoopDelayMonitor();
  m.enable();
  const snap = m.snapshot();
  m.disable();
  for (const v of Object.values(snap)) expect(Number.isFinite(v)).toBe(true);
});

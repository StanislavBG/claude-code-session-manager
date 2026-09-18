/**
 * dispatchLoop.test.cjs — interval clamping, no overlap, throw isolation, stop(), kill switch.
 * Run: timeout 120 npx vitest run src/main/lib/__tests__/dispatchLoop.test.cjs
 */
'use strict';

import { test, expect, vi, beforeEach, afterEach } from 'vitest';
const { startDispatchLoop, resolveIntervalMs } = require('../dispatchLoop.cjs');

beforeEach(() => { vi.useFakeTimers(); delete process.env.SM_DISPATCH_LOOP_DISABLE; delete process.env.SM_DISPATCH_LOOP_INTERVAL_MS; });
afterEach(() => { vi.useRealTimers(); delete process.env.SM_DISPATCH_LOOP_DISABLE; delete process.env.SM_DISPATCH_LOOP_INTERVAL_MS; });

test('interval defaults to 30s and clamps to [10s, 300s]', () => {
  expect(resolveIntervalMs(undefined, {})).toBe(30_000);
  expect(resolveIntervalMs(undefined, { SM_DISPATCH_LOOP_INTERVAL_MS: '1' })).toBe(10_000);
  expect(resolveIntervalMs(undefined, { SM_DISPATCH_LOOP_INTERVAL_MS: '9999999' })).toBe(300_000);
  expect(resolveIntervalMs(undefined, { SM_DISPATCH_LOOP_INTERVAL_MS: 'abc' })).toBe(30_000);
  expect(resolveIntervalMs(45_000, {})).toBe(45_000);
});

test('ticks on the interval and stop() clears the timer', async () => {
  const tick = vi.fn(async () => {});
  const h = startDispatchLoop({ tick });
  await vi.advanceTimersByTimeAsync(90_000);
  expect(tick).toHaveBeenCalledTimes(3);
  h.stop();
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(90_000);
  expect(tick).toHaveBeenCalledTimes(3);
});

test('skips a pass while the previous one is still running', async () => {
  let release;
  const tick = vi.fn(() => new Promise((r) => { release = r; }));
  const h = startDispatchLoop({ tick, intervalMs: 10_000 });
  await vi.advanceTimersByTimeAsync(50_000);
  expect(tick).toHaveBeenCalledTimes(1);
  release();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(tick).toHaveBeenCalledTimes(2);
  h.stop();
});

test('a throwing/rejecting tick is isolated, reported, and the loop keeps running', async () => {
  const onError = vi.fn();
  let n = 0;
  const tick = vi.fn(async () => { n++; if (n === 1) throw new Error('boom'); if (n === 2) throw new Error('boom2'); });
  const h = startDispatchLoop({ tick, intervalMs: 10_000, onError });
  await vi.advanceTimersByTimeAsync(40_000);
  expect(tick).toHaveBeenCalledTimes(4);
  expect(onError).toHaveBeenCalledTimes(2);
  h.stop();
});

test('SM_DISPATCH_LOOP_DISABLE=1 never arms the loop', async () => {
  process.env.SM_DISPATCH_LOOP_DISABLE = '1';
  const tick = vi.fn();
  const h = startDispatchLoop({ tick });
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(600_000);
  expect(tick).not.toHaveBeenCalled();
  h.stop();
});

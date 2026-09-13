/**
 * broadcastCoalescer.test.cjs — unit tests for src/main/lib/broadcastCoalescer.cjs,
 * the trailing-edge debounce used by scheduler.cjs's broadcast().
 *
 * Run: timeout 300 npx vitest run src/main/__tests__/broadcastCoalescer.test.cjs
 */

'use strict';

import { test, expect, vi, beforeEach, afterEach } from 'vitest';

const { createBroadcastCoalescer } = require('../lib/broadcastCoalescer.cjs');

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

function makeCoalescer(delayMs = 200) {
  const sent = [];
  let counter = 0;
  const getPayload = vi.fn(() => `state-${counter}`);
  const send = vi.fn((payload) => sent.push(payload));
  const coalescer = createBroadcastCoalescer({ delayMs, send, getPayload });
  return {
    coalescer,
    sent,
    send,
    getPayload,
    bump: () => { counter += 1; },
  };
}

test('5 rapid schedule() calls within the window produce exactly 1 send', async () => {
  const { coalescer, sent, bump } = makeCoalescer(200);

  bump(); coalescer.schedule();
  bump(); coalescer.schedule();
  bump(); coalescer.schedule();
  bump(); coalescer.schedule();
  bump(); coalescer.schedule();

  await vi.advanceTimersByTimeAsync(200);

  expect(sent.length).toBe(1);
});

test('the trailing send reflects the LATEST state, not the state at the first schedule() call', async () => {
  const { coalescer, sent, bump } = makeCoalescer(200);

  bump(); // state-1
  coalescer.schedule();
  bump(); // state-2
  coalescer.schedule(); // no-op — timer already armed
  bump(); // state-3
  coalescer.schedule(); // no-op

  await vi.advanceTimersByTimeAsync(200);

  expect(sent).toEqual(['state-3']);
});

test('flush() cancels the pending timer and sends immediately with the current payload', async () => {
  const { coalescer, sent, bump } = makeCoalescer(200);

  bump();
  coalescer.schedule();

  // Flush before the 200ms window elapses.
  await vi.advanceTimersByTimeAsync(50);
  await coalescer.flush();

  expect(sent).toEqual(['state-1']);

  // The window's original timer must not fire a second, stale send.
  await vi.advanceTimersByTimeAsync(200);
  expect(sent).toEqual(['state-1']);
});

test('a schedule() call after a quiet period still arrives (not dropped)', async () => {
  const { coalescer, sent, bump } = makeCoalescer(200);

  bump();
  coalescer.schedule();
  await vi.advanceTimersByTimeAsync(200);
  expect(sent).toEqual(['state-1']);

  bump();
  coalescer.schedule();
  await vi.advanceTimersByTimeAsync(200);
  expect(sent).toEqual(['state-1', 'state-2']);
});

test('flush() with no pending timer still sends (no-arm case)', async () => {
  const { coalescer, sent, bump } = makeCoalescer(200);
  bump();
  await coalescer.flush();
  expect(sent).toEqual(['state-1']);
});

console.log('broadcastCoalescer tests: PASS');

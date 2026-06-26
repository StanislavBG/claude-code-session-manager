/**
 * chat-queue.test.cjs — unit tests for the chatRunner serial run queue (v0.34).
 * Asserts the "one loop at a time" guarantee: runs execute serially in FIFO
 * order, and a queued (not-yet-started) run can be cancelled without running.
 *
 * Run: timeout 120 node --test src/main/__tests__/chat-queue.test.cjs
 */

'use strict';

// Force the default cap (1) regardless of the developer's shell env.
delete process.env.SM_CHAT_CONCURRENCY;

const { test } = require('node:test');
const assert = require('node:assert/strict');
const cr = require('../chatRunner.cjs');

const tick = () => new Promise((r) => setImmediate(r));
const job = (id) => ({ tabId: id, sessionId: id, prompt: 'x', cwd: '/', resume: false });

test('runs execute one at a time in FIFO order', async () => {
  const order = [];
  let active = 0;
  let maxActive = 0;
  // Stub the spawn: each run resolves on the next tick, so the queue must
  // advance via the pump's finally hook for B and C to ever run.
  cr.__setExecutor((j) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    order.push(j.tabId);
    return new Promise((res) => setImmediate(() => { active -= 1; res(); }));
  });

  cr.run(job('A'));
  cr.run(job('B'));
  cr.run(job('C'));

  // Drain the queue (each run takes one tick; allow generous headroom).
  for (let i = 0; i < 12 && order.length < 3; i++) await tick();
  await tick();

  assert.equal(maxActive, 1, 'never more than one run active at once');
  assert.deepEqual(order, ['A', 'B', 'C'], 'runs execute in FIFO order');

  cr.__setExecutor(null); // restore real executor
});

test('cancelling a queued run drops it without executing', async () => {
  const order = [];
  cr.__setExecutor((j) => {
    order.push(j.tabId);
    return new Promise((res) => setImmediate(res));
  });

  // X takes the only lane; Y queues behind it. Cancel Y before the lane frees.
  cr.run(job('X'));
  cr.run(job('Y'));
  cr.cancel('Y'); // Y is still in the waiting list — drop it

  for (let i = 0; i < 8; i++) await tick();

  assert.deepEqual(order, ['X'], 'only X ran; Y was cancelled while queued');

  cr.__setExecutor(null);
});

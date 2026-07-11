/**
 * chat-queue.test.cjs — unit tests for the chatRunner serial run queue (v0.34).
 * Asserts the "up to two loops at a time" guarantee: runs execute up to the
 * concurrency cap in FIFO order, and a queued (not-yet-started) run can be
 * cancelled without running.
 *
 * Run: timeout 120 node --test src/main/__tests__/chat-queue.test.cjs
 */

'use strict';

// Force the default cap (2) regardless of the developer's shell env.
delete process.env.SM_CHAT_CONCURRENCY;

const { test } = require('node:test');
const assert = require('node:assert/strict');
const cr = require('../chatRunner.cjs');

const tick = () => new Promise((r) => setImmediate(r));
const job = (id) => ({ tabId: id, sessionId: id, prompt: 'x', cwd: '/', resume: false });

test('runs execute up to the concurrency cap in FIFO order', async () => {
  const order = [];
  let active = 0;
  let maxActive = 0;
  // Stub the spawn: each run resolves on the next tick, so the queue must
  // advance via the pump's finally hook for C to ever run.
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

  assert.equal(maxActive, 2, 'up to two runs active at once under the default cap');
  assert.deepEqual(order, ['A', 'B', 'C'], 'runs execute in FIFO order');

  cr.__setExecutor(null); // restore real executor
});

test('cancelling a queued run drops it without executing', async () => {
  const order = [];
  cr.__setExecutor((j) => {
    order.push(j.tabId);
    return new Promise((res) => setImmediate(res));
  });

  // X and Y each take one of the two lanes; Z queues behind them. Cancel Z
  // before a lane frees.
  cr.run(job('X'));
  cr.run(job('Y'));
  cr.run(job('Z'));
  cr.cancel('Z'); // Z is still in the waiting list — drop it

  for (let i = 0; i < 8; i++) await tick();

  assert.deepEqual(order, ['X', 'Y'], 'only X and Y ran; Z was cancelled while queued');

  cr.__setExecutor(null);
});

/**
 * chat-queue.test.cjs — unit tests for the chatRunner run queue.
 * chatRunner has NO private concurrency cap: a queued run starts exactly when
 * lib/scheduler/sessionSlots.cjs grants a slot (the sole machine-wide cap).
 * These tests pin the pool with SM_SESSION_SLOTS and assert FIFO ordering and
 * cancel-while-waiting through that gate.
 *
 * Run: timeout 300 npx vitest run src/main/__tests__/chat-queue.test.cjs
 */

'use strict';

import { test, beforeEach, afterEach } from 'vitest';
const assert = require('node:assert/strict');
const cr = require('../chatRunner.cjs');

const ORIGINAL_SLOTS = process.env.SM_SESSION_SLOTS;
beforeEach(() => {
  process.env.SM_SESSION_SLOTS = '2';
  cr.__resetQueueForTests();
});
afterEach(() => {
  cr.__setExecutor(null);
  cr.attachWindow(null);
  cr.__resetQueueForTests();
  if (ORIGINAL_SLOTS === undefined) delete process.env.SM_SESSION_SLOTS;
  else process.env.SM_SESSION_SLOTS = ORIGINAL_SLOTS;
});

const tick = () => new Promise((r) => setImmediate(r));
const job = (id) => ({ tabId: id, sessionId: id, prompt: 'x', cwd: '/', resume: true, silent: true });

// Executor whose runs stay in flight (holding a slot) until released manually.
function holdingExecutor() {
  const order = [];
  const resolvers = [];
  cr.__setExecutor((j) => {
    order.push(j.tabId);
    return new Promise((res) => resolvers.push(res));
  });
  return { order, resolvers };
}

test('queued runs start in FIFO order as sessionSlots frees slots', async () => {
  const { order, resolvers } = holdingExecutor();

  cr.run(job('A'));
  cr.run(job('B'));
  cr.run(job('C'));
  for (let i = 0; i < 4; i++) await tick();
  assert.deepEqual(order, ['A', 'B'], 'only as many runs start as the slot pool grants');

  resolvers[0](); // A finishes -> releases its slot -> C starts
  for (let i = 0; i < 4; i++) await tick();
  assert.deepEqual(order, ['A', 'B', 'C'], 'runs execute in FIFO order');

  resolvers.slice(1).forEach((r) => r());
  await tick();
});

test('cancelling a run waiting for a session slot drops it without executing', async () => {
  const { order, resolvers } = holdingExecutor();

  cr.run(job('X'));
  cr.run(job('Y'));
  cr.run(job('Z')); // no slot free: waits
  for (let i = 0; i < 4; i++) await tick();
  cr.cancel('Z'); // still waiting for a slot — drop it

  resolvers[0]();
  for (let i = 0; i < 6; i++) await tick();

  assert.deepEqual(order, ['X', 'Y'], 'Z was cancelled while waiting and never ran');

  resolvers.slice(1).forEach((r) => r());
  await tick();
});

test('a queued silent run never broadcasts chat:run:queued (silent runs stay invisible to the renderer)', async () => {
  const sent = [];
  cr.attachWindow({
    isDestroyed: () => false,
    webContents: { isDestroyed: () => false, send: (channel, payload) => sent.push({ channel, payload }) },
  });
  const { resolvers } = holdingExecutor();

  // P and Q take the two slots; R waits for a slot — every job on the
  // waiting list here is silent.
  cr.run(job('P'));
  cr.run(job('Q'));
  cr.run(job('R'));

  for (let i = 0; i < 8; i++) await tick();

  assert.equal(
    sent.filter((s) => s.channel === 'chat:run:queued').length,
    0,
    'no chat:run:queued broadcast for a silent (automated probe) run',
  );

  resolvers.forEach((r) => r());
  await tick();
});

/**
 * chat-exit-close-race.test.cjs — regression for the exit/close race that
 * silently dropped a pure-text-only final turn (PRD 716).
 *
 * Bug: the terminal-event fallback was wired to `child.on('exit', ...)`
 * instead of `child.on('close', ...)`. Node only guarantees all buffered
 * stdout 'data' events have been delivered by 'close', not 'exit' — 'exit'
 * can fire before the final stdout chunk (last assistant text + terminating
 * `result` line) reaches the parent's 'data' handler. When that happened,
 * the exit fallback ran first, set the one-shot terminalSent latch, and
 * broadcast a misleading chat:run:error. The real result line then parsed
 * moments later, but emitTerminal silently no-op'd and the genuine
 * chat:run:complete was dropped.
 *
 * Fix: use `child.on('close', ...)` for the fallback so it only fires once
 * Node guarantees stdout is fully drained — a real result event that arrives
 * (even "late", right up against process exit) always wins.
 *
 * This test mocks node:child_process.spawn so it can deterministically
 * reproduce the exact race ordering (exit fires, THEN the final stdout chunk
 * arrives, THEN close fires) rather than relying on real OS/pipe timing,
 * which is not reliably reproducible from a real child process.
 *
 * Run: timeout 120 node --test src/main/__tests__/chat-exit-close-race.test.cjs
 */

'use strict';

delete process.env.SM_CHAT_CONCURRENCY;

const { test } = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const cp = require('node:child_process');

// Replace spawn BEFORE chatRunner.cjs is first required, so the module's
// top-level `const { spawn } = require('node:child_process')` destructuring
// captures this mock instead of the real implementation.
const originalSpawn = cp.spawn;
let nextChild = null;
cp.spawn = () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = 424242;
  child.kill = () => {};
  nextChild = child;
  return child;
};

const cr = require('../chatRunner.cjs');

const tick = () => new Promise((r) => setImmediate(r));

test('a final-text-only turn whose stdout chunk lands after exit still surfaces chat:run:complete', async () => {
  nextChild = null;
  const events = [];
  cr.attachWindow({
    isDestroyed: () => false,
    webContents: {
      isDestroyed: () => false,
      send: (channel, payload) => events.push({ channel, payload }),
    },
  });

  cr.run({ tabId: 'T2', sessionId: 'S2', prompt: 'show me a sample post', cwd: process.cwd(), resume: false });

  for (let i = 0; i < 20 && !nextChild; i++) await tick();
  const child = nextChild;
  assert.ok(child, 'spawn should have been invoked');

  const text = 'Here is your sample post, all in one go.';
  const lines =
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } }) +
    '\n' +
    JSON.stringify({ type: 'result', subtype: 'success', result: text }) +
    '\n';

  // The exact race: 'exit' fires first (process already gone from the OS's
  // perspective), the final stdout chunk is delivered to the 'data' handler
  // only after that, and 'close' — which Node guarantees fires after all
  // stdout data has been delivered — fires last.
  child.emit('exit', 0, null);
  child.stdout.emit('data', Buffer.from(lines));
  child.emit('close', 0, null);

  await tick();
  await tick();

  const terminal = events.filter((e) => isTerminal(e.channel));
  assert.equal(terminal.length, 1, 'exactly one terminal event is emitted');
  assert.equal(
    terminal[0].channel,
    'chat:run:complete',
    'the real result event must win over the generic exit-fallback error',
  );
  assert.equal(terminal[0].payload.finalMessage, text);
});

test('a crashed process with no result event ever emitted still fires the fallback chat:run:error', async () => {
  nextChild = null;
  const events = [];
  cr.attachWindow({
    isDestroyed: () => false,
    webContents: {
      isDestroyed: () => false,
      send: (channel, payload) => events.push({ channel, payload }),
    },
  });

  cr.run({ tabId: 'T3', sessionId: 'S3', prompt: 'anything', cwd: process.cwd(), resume: false });

  for (let i = 0; i < 20 && !nextChild; i++) await tick();
  const child = nextChild;
  assert.ok(child, 'spawn should have been invoked');

  // Crashes with no stdout at all — 'close' is the only event that fires.
  child.emit('close', 1, null);

  await tick();
  await tick();

  const terminal = events.filter((e) => isTerminal(e.channel));
  assert.equal(terminal.length, 1, 'exactly one terminal event is emitted');
  assert.equal(terminal[0].channel, 'chat:run:error', 'a crash with no result surfaces as an error turn');
  assert.match(terminal[0].payload.message, /process exited without a result event/);
});

function isTerminal(channel) {
  return (
    channel === 'chat:run:complete' ||
    channel === 'chat:run:needs-input' ||
    channel === 'chat:run:error'
  );
}

test.after(() => {
  cp.spawn = originalSpawn;
  delete process.env.SM_CHAT_CONCURRENCY;
});

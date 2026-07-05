/**
 * chat-cancel-terminal.test.cjs — regression for the "stuck thinking" hang.
 *
 * Bug (2026-07-05): cancelling an active chat run SIGTERM'd the child, but the
 * exit handler's `if (!gotResult && !killed)` guard skipped every broadcast
 * because `killed === true`. No terminal IPC event ever reached the renderer,
 * so the chat store stayed `running:true` forever — disabled textarea, endless
 * "running…" spinner, unresponsive chat UI.
 *
 * Fix: every run emits EXACTLY ONE terminal event (complete/needs-input/error),
 * and the exit path emits a fallback `chat:run:error` when a run settled
 * without one (cancel, crash, silent exit). This test drives the REAL spawn
 * path (via SM_CLAUDE_BIN pointing at a stub process) and asserts a terminal
 * event is broadcast on cancel.
 *
 * Run: timeout 120 node --test src/main/__tests__/chat-cancel-terminal.test.cjs
 */

'use strict';

delete process.env.SM_CHAT_CONCURRENCY;

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// A stub "claude" that ignores stdin/args and stays alive until killed —
// mimics a long-running headless run so cancel() has something to SIGTERM.
// Shebang + chmod makes it directly spawnable as a single executable (spawn
// does not split a path on spaces, so SM_CLAUDE_BIN must be one binary).
const stubPath = path.join(os.tmpdir(), `sm-claude-stub-${process.pid}.cjs`);
fs.writeFileSync(
  stubPath,
  `#!${process.execPath}\nsetInterval(() => {}, 1000);\n`,
  { mode: 0o755 },
);
process.env.SM_CLAUDE_BIN = stubPath;

const cr = require('../chatRunner.cjs');

const tick = () => new Promise((r) => setImmediate(r));

test('cancelling an ACTIVE run broadcasts a terminal event (unsticks the UI)', async () => {
  const events = [];
  // Fake BrowserWindow that captures every broadcast.
  cr.attachWindow({
    isDestroyed: () => false,
    webContents: {
      isDestroyed: () => false,
      send: (channel, payload) => events.push({ channel, payload }),
    },
  });

  cr.run({ tabId: 'T', sessionId: 'S', prompt: 'hello', cwd: process.cwd(), resume: false });

  // Let the spawn happen and started event fire.
  for (let i = 0; i < 6; i++) await tick();
  assert.ok(
    events.some((e) => e.channel === 'chat:run:started'),
    'started event should fire once the run launches',
  );

  cr.cancel('T');

  // Wait for SIGTERM → child exit → fallback terminal broadcast.
  for (let i = 0; i < 40 && !events.some((e) => isTerminal(e.channel)); i++) {
    await new Promise((r) => setTimeout(r, 25));
  }

  const terminal = events.filter((e) => isTerminal(e.channel));
  assert.equal(terminal.length, 1, 'exactly one terminal event is emitted');
  assert.equal(terminal[0].channel, 'chat:run:error', 'cancel surfaces as an error turn');
  assert.match(terminal[0].payload.message, /cancel/i, 'message names the cancellation');
});

function isTerminal(channel) {
  return (
    channel === 'chat:run:complete' ||
    channel === 'chat:run:needs-input' ||
    channel === 'chat:run:error'
  );
}

test.after(() => {
  try { fs.unlinkSync(stubPath); } catch { /* already gone */ }
  delete process.env.SM_CLAUDE_BIN;
});

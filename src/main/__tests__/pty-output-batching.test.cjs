/**
 * pty-output-batching.test.cjs — PRD 1521: proves PtyManager coalesces
 * node-pty onData chunks into a single `pty:data:<tabId>` send per
 * PTY_FLUSH_MS window (or immediately past the size cap), flushes any
 * pending output before the exit event, and never sends after kill/dispose.
 *
 * Follows the fake-pty / monkey-patched node-pty.spawn pattern from
 * pty-epic-worktree-spawn-cwd.test.cjs (no existing test in this repo uses
 * vi.mock for node-pty) and a fake window/webContents like
 * pty-write-result.test.cjs's session-map pattern.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/pty-output-batching.test.cjs
 */

'use strict';

import { test, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let tmpHome;
let originalHome;
let manager;
let nodePty;
let originalSpawn;

beforeAll(() => {
  originalHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-pty-batching-home-'));
  process.env.HOME = tmpHome;
  ({ manager } = require('../pty.cjs'));
  nodePty = require('node-pty');
  originalSpawn = nodePty.spawn;
});

afterAll(() => {
  nodePty.spawn = originalSpawn;
  process.env.HOME = originalHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  nodePty.spawn = originalSpawn;
  manager.sessions.clear();
  manager.buffers.clear();
  manager.killed.clear();
  manager.outBuffers.clear();
  for (const t of manager.flushTimers.values()) clearTimeout(t);
  manager.flushTimers.clear();
  manager.window = null;
});

/** Fake node-pty process: captures the onData/onExit callbacks so the test
 *  can drive them directly without a real shell. */
function fakeProc(capture) {
  return {
    pid: 4242,
    exitCode: null,
    onData: (cb) => { capture.onData = cb; },
    onExit: (cb) => { capture.onExit = cb; },
    resize: () => {},
    kill: () => {},
    write: () => {},
  };
}

function fakeWindow(sent) {
  return {
    isDestroyed: () => false,
    webContents: {
      isDestroyed: () => false,
      isCrashed: () => false,
      send: (channel, payload) => sent.push({ channel, payload }),
    },
  };
}

function spawnFake(tabId) {
  const capture = {};
  nodePty.spawn = () => fakeProc(capture);
  const mainCwd = fs.mkdtempSync(path.join(tmpHome, 'sm-pty-batch-'));
  const sent = [];
  manager.window = fakeWindow(sent);
  manager.spawn({ tabId, cwd: mainCwd, cols: 80, rows: 24 });
  return { capture, sent };
}

test('many chunks within the flush window coalesce into one send, concatenated in order', () => {
  const tabId = 'batch-tab-coalesce';
  const { capture, sent } = spawnFake(tabId);

  capture.onData('one-');
  capture.onData('two-');
  capture.onData('three');

  // Nothing sent yet — still inside the PTY_FLUSH_MS window.
  expect(sent.filter((m) => m.channel === `pty:data:${tabId}`)).toHaveLength(0);

  vi.advanceTimersByTime(8);

  const dataSends = sent.filter((m) => m.channel === `pty:data:${tabId}`);
  expect(dataSends).toHaveLength(1);
  expect(dataSends[0].payload).toBe('one-two-three');

  manager.kill(tabId);
});

test('a chunk pushing the buffer past 64 KB flushes immediately, without waiting for the timer', () => {
  const tabId = 'batch-tab-sizecap';
  const { capture, sent } = spawnFake(tabId);

  const big = 'x'.repeat(64 * 1024 + 1);
  capture.onData(big);

  // Flushed synchronously inside onData — no timer advance needed.
  const dataSends = sent.filter((m) => m.channel === `pty:data:${tabId}`);
  expect(dataSends).toHaveLength(1);
  expect(dataSends[0].payload).toBe(big);

  manager.kill(tabId);
});

test('pending output is flushed before the exit event is sent', () => {
  const tabId = 'batch-tab-exit';
  const { capture, sent } = spawnFake(tabId);

  capture.onData('leftover-output');
  // No timer advance — output is still buffered when the process exits.
  capture.onExit({ exitCode: 0, signal: undefined });

  const relevant = sent.filter((m) => m.channel === `pty:data:${tabId}` || m.channel === `pty:exit:${tabId}`);
  expect(relevant.map((m) => m.channel)).toEqual([`pty:data:${tabId}`, `pty:exit:${tabId}`]);
  expect(relevant[0].payload).toBe('leftover-output');
});

test('kill clears the flush timer and buffer — no send is made even after the window elapses', () => {
  const tabId = 'batch-tab-kill';
  const { capture, sent } = spawnFake(tabId);

  capture.onData('will-be-dropped');
  manager.kill(tabId);

  vi.advanceTimersByTime(100);

  expect(sent.filter((m) => m.channel === `pty:data:${tabId}`)).toHaveLength(0);
  expect(manager.outBuffers.has(tabId)).toBe(false);
  expect(manager.flushTimers.has(tabId)).toBe(false);
});

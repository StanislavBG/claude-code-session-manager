/**
 * pty-output-listeners.test.cjs — PtyManager.addOutputListener delivers the
 * coalesced output + exit to main-process consumers without changing what the
 * renderer receives. Stubbing mirrors pty-output-batching.test.cjs.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/pty-output-listeners.test.cjs
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
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-pty-listeners-home-'));
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
  manager.outputListeners.clear();
  for (const t of manager.flushTimers.values()) clearTimeout(t);
  manager.flushTimers.clear();
  manager.window = null;
});

function fakeProc(capture) {
  return {
    pid: 4243,
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
  const mainCwd = fs.mkdtempSync(path.join(tmpHome, 'sm-pty-lis-'));
  const sent = [];
  manager.window = fakeWindow(sent);
  manager.spawn({ tabId, cwd: mainCwd, cols: 80, rows: 24 });
  return { capture, sent };
}

test('listener receives the same coalesced string the renderer gets', () => {
  const tabId = 'lis-tab-data';
  const { capture, sent } = spawnFake(tabId);
  const onData = vi.fn();
  manager.addOutputListener(tabId, onData);

  capture.onData('a-');
  capture.onData('b');
  expect(onData).not.toHaveBeenCalled();
  vi.advanceTimersByTime(8);

  expect(onData).toHaveBeenCalledTimes(1);
  expect(onData).toHaveBeenCalledWith(tabId, 'a-b');
  expect(sent.find((m) => m.channel === `pty:data:${tabId}`).payload).toBe('a-b');
  manager.kill(tabId);
});

test('unsubscribe stops delivery and removes the empty set', () => {
  const tabId = 'lis-tab-unsub';
  const { capture } = spawnFake(tabId);
  const onData = vi.fn();
  const off = manager.addOutputListener(tabId, onData);
  off();
  expect(manager.outputListeners.has(tabId)).toBe(false);

  capture.onData('x');
  vi.advanceTimersByTime(8);
  expect(onData).not.toHaveBeenCalled();
  manager.kill(tabId);
});

test('a throwing listener does not block the renderer send or other listeners', () => {
  const tabId = 'lis-tab-throw';
  const { capture, sent } = spawnFake(tabId);
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const bad = vi.fn(() => { throw new Error('boom'); });
  const good = vi.fn();
  manager.addOutputListener(tabId, bad);
  manager.addOutputListener(tabId, good);

  capture.onData('hello');
  vi.advanceTimersByTime(8);

  expect(bad).toHaveBeenCalledTimes(1);
  expect(good).toHaveBeenCalledWith(tabId, 'hello');
  expect(sent.filter((m) => m.channel === `pty:data:${tabId}`)).toHaveLength(1);
  warn.mockRestore();
  manager.kill(tabId);
});

test('exit fires onExit once (after final data) and clears the tab listeners', () => {
  const tabId = 'lis-tab-exit';
  const { capture } = spawnFake(tabId);
  const order = [];
  const onExit = vi.fn(() => order.push('exit'));
  manager.addOutputListener(tabId, () => order.push('data'), onExit);

  capture.onData('tail');
  capture.onExit({ exitCode: 3, signal: undefined });

  expect(order).toEqual(['data', 'exit']);
  expect(onExit).toHaveBeenCalledWith(tabId, { exitCode: 3, signal: undefined });
  expect(manager.outputListeners.has(tabId)).toBe(false);
});

test('suppressed-killed exit notifies listeners but not the renderer', () => {
  const tabId = 'lis-tab-killed';
  const { capture, sent } = spawnFake(tabId);
  const onExit = vi.fn();
  manager.addOutputListener(tabId, () => {}, onExit);

  manager.killed.add(tabId); // simulate kill() having marked it, exit event still pending
  capture.onExit({ exitCode: 1, signal: 15 });

  expect(onExit).toHaveBeenCalledTimes(1);
  expect(onExit).toHaveBeenCalledWith(tabId, { exitCode: 1, signal: 15 });
  expect(sent.filter((m) => m.channel === `pty:exit:${tabId}`)).toHaveLength(0);
  expect(manager.outputListeners.has(tabId)).toBe(false);
});

test('kill notifies once and removes listeners; the later exit event does not re-fire', () => {
  const tabId = 'lis-tab-kill';
  const { capture } = spawnFake(tabId);
  const onExit = vi.fn();
  manager.addOutputListener(tabId, () => {}, onExit);

  manager.kill(tabId);
  expect(onExit).toHaveBeenCalledTimes(1);
  expect(manager.outputListeners.has(tabId)).toBe(false);

  capture.onExit({ exitCode: 0, signal: 15 });
  expect(onExit).toHaveBeenCalledTimes(1);
});

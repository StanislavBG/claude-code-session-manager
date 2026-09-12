/**
 * pty-session-open-telemetry.test.cjs — proves the `session.open` counter tap
 * (telemetryCounters.trackSessionOpen(), wired at pty.cjs's spawn() call
 * site) actually fires on a real fresh PTY spawn, and documents/locks in the
 * deliberate choice that a reattach (same tabId already registered in this
 * process — a renderer HMR reload, or switching back to an Epic's Terminal
 * pane that's already running) does NOT fire it a second time, since it's
 * the same underlying session, not a new one (see pty.cjs's spawn() comment
 * above the reattach branch, and telemetry.md).
 *
 * Same monkey-patch-node-pty pattern as pty-epic-worktree-spawn-cwd.test.cjs
 * — no existing test in this repo mocks a module import.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/pty-session-open-telemetry.test.cjs
 */

'use strict';

import { test, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let tmpHome;
let originalHome;
let manager;
let nodePty;
let originalSpawn;
let telemetryCounters;

beforeAll(() => {
  originalHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-pty-sessionopen-home-'));
  process.env.HOME = tmpHome;
  ({ manager } = require('../pty.cjs'));
  nodePty = require('node-pty');
  originalSpawn = nodePty.spawn;
  telemetryCounters = require('../lib/telemetryCounters.cjs');
});

afterAll(() => {
  nodePty.spawn = originalSpawn;
  process.env.HOME = originalHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

afterEach(() => {
  nodePty.spawn = originalSpawn;
  manager.sessions.clear();
  manager.buffers.clear();
  manager.killed.clear();
  vi.restoreAllMocks();
});

function fakeProc() {
  return {
    pid: 4242,
    exitCode: null,
    onData: () => {},
    onExit: () => {},
    resize: () => {},
    kill: () => {},
    write: () => {},
  };
}

test('a fresh spawn() fires trackSessionOpen exactly once', () => {
  const spy = vi.spyOn(telemetryCounters, 'trackSessionOpen').mockImplementation(() => {});
  const cwd = fs.mkdtempSync(path.join(tmpHome, 'sm-pty-fresh-'));
  const tabId = 'fresh-tab-1';
  nodePty.spawn = () => fakeProc();

  manager.spawn({ tabId, cwd, cols: 80, rows: 24 });

  expect(spy).toHaveBeenCalledTimes(1);
  manager.kill(tabId);
});

test('a reattach to an already-registered tabId does NOT fire trackSessionOpen again', () => {
  const spy = vi.spyOn(telemetryCounters, 'trackSessionOpen').mockImplementation(() => {});
  const cwd = fs.mkdtempSync(path.join(tmpHome, 'sm-pty-reattach-'));
  const tabId = 'reattach-tab-1';
  nodePty.spawn = () => fakeProc();

  const first = manager.spawn({ tabId, cwd, cols: 80, rows: 24 });
  expect(first.reattached).toBe(false);
  expect(spy).toHaveBeenCalledTimes(1);

  const second = manager.spawn({ tabId, cwd, cols: 80, rows: 24 });
  expect(second.reattached).toBe(true);
  // Still exactly one call — the reattach path returns before the counter
  // tap, by design (same session, not a new one).
  expect(spy).toHaveBeenCalledTimes(1);

  manager.kill(tabId);
});

/**
 * bootSelfHeal.test.cjs — the epic-index self-heal scan must be SCHEDULED
 * off app.whenReady()'s synchronous critical path, not executed inline, so
 * the ~270ms allProjectCwds() scan can't compete with the renderer's first
 * IPC round trips (schedule.state, billing.fetch, teams.list) for the event
 * loop at boot.
 *
 * Run: timeout 300 npx vitest run src/main/lib/__tests__/bootSelfHeal.test.cjs
 */

'use strict';

import { test, expect, vi } from 'vitest';
const { EventEmitter } = require('node:events');
const { scheduleBootSelfHeal, runEpicIndexSelfHeal } = require('../bootSelfHeal.cjs');

function flush(times = 2) {
  return (async () => {
    for (let i = 0; i < times; i++) {
      await new Promise((resolve) => { setImmediate(resolve); });
    }
  })();
}

function makeDeps() {
  return {
    fs: { existsSync: vi.fn(() => true), readFileSync: vi.fn(() => '{}') },
    allProjectCwds: vi.fn(() => ['/proj-a']),
    promptSessionsActiveIndexPath: (cwd) => `${cwd}/active-index.json`,
    rebuildActiveIndex: vi.fn(() => ({ rows: [], skipped: [] })),
    logs: { writeLine: vi.fn() },
  };
}

function fakeWindow() {
  const webContents = new EventEmitter();
  webContents.isDestroyed = () => false;
  return { isDestroyed: () => false, webContents };
}

test('scheduleBootSelfHeal does not run the scan synchronously — only after did-finish-load', async () => {
  const deps = makeDeps();
  const mainWindow = fakeWindow();

  scheduleBootSelfHeal(mainWindow, deps);
  expect(deps.allProjectCwds).not.toHaveBeenCalled();

  mainWindow.webContents.emit('did-finish-load');
  expect(deps.allProjectCwds).toHaveBeenCalledTimes(1);
  await flush();
});

test('a window destroyed before did-finish-load falls back to an unconditional setImmediate run', async () => {
  const deps = makeDeps();
  const mainWindow = fakeWindow();

  scheduleBootSelfHeal(mainWindow, deps);
  mainWindow.webContents.emit('destroyed');
  expect(deps.allProjectCwds).not.toHaveBeenCalled();

  await flush();
  expect(deps.allProjectCwds).toHaveBeenCalledTimes(1);
});

test('a headless / no-window boot still self-heals via setImmediate', async () => {
  const deps = makeDeps();

  scheduleBootSelfHeal(null, deps);
  expect(deps.allProjectCwds).not.toHaveBeenCalled();

  await flush();
  expect(deps.allProjectCwds).toHaveBeenCalledTimes(1);
});

test('runs exactly once per boot even if did-finish-load and destroyed both fire', async () => {
  const deps = makeDeps();
  const mainWindow = fakeWindow();

  scheduleBootSelfHeal(mainWindow, deps);
  mainWindow.webContents.emit('did-finish-load');
  mainWindow.webContents.emit('destroyed');
  await flush();

  expect(deps.allProjectCwds).toHaveBeenCalledTimes(1);
});

test('runEpicIndexSelfHeal rebuilds only a project whose index is missing or unparseable — a clean index is never rewritten', async () => {
  const files = {
    '/clean-proj/active-index.json': '{"sessions":{}}',
    '/broken-proj/active-index.json': '{ not json',
  };
  const fs = {
    existsSync: (p) => Object.prototype.hasOwnProperty.call(files, p),
    readFileSync: (p) => files[p],
  };
  const rebuildActiveIndex = vi.fn(() => ({ rows: [], skipped: [] }));
  const logs = { writeLine: vi.fn() };
  const allProjectCwds = () => ['/clean-proj', '/broken-proj', '/missing-proj'];
  const promptSessionsActiveIndexPath = (cwd) => `${cwd}/active-index.json`;

  await runEpicIndexSelfHeal({ fs, allProjectCwds, promptSessionsActiveIndexPath, rebuildActiveIndex, logs });

  expect(rebuildActiveIndex).toHaveBeenCalledTimes(2);
  expect(rebuildActiveIndex).toHaveBeenCalledWith('/broken-proj');
  expect(rebuildActiveIndex).toHaveBeenCalledWith('/missing-proj');
  expect(rebuildActiveIndex).not.toHaveBeenCalledWith('/clean-proj');
});

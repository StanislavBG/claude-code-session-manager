/**
 * browserView-destroyed-handler.test.cjs — regression test for the
 * webContents.id-after-destroy crash (see
 * session-manager-operations/feedback/processed/
 * 2026-07-30-rca-v0390-blank-screen-unstable-selector-185.md, item 4).
 *
 * The webContents `'destroyed'` handler used to read `view.webContents.id`
 * from inside its own callback, after `view.webContents` could already be
 * undefined — throwing "Cannot read properties of undefined (reading 'id')"
 * on every app quit with an open Browser view. The fix captures the id at
 * creation time, before the destroyed handler is registered.
 *
 * `electron` isn't installed as a runnable binary here, and browserView.cjs
 * pulls it in via a plain CJS `require` (not vite-node's ESM graph), so
 * `vi.mock('electron', ...)` doesn't intercept it. Instead we pre-seed
 * Node's own require cache for the resolved `electron` path with a fake
 * `WebContentsView`, the only export browserView.cjs actually uses.
 *
 * Run: timeout 300 npx vitest run src/main/__tests__/browserView-destroyed-handler.test.cjs
 */

'use strict';

import { test, expect, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

let nextWcId = 1;
class FakeWebContents extends EventEmitter {
  constructor() {
    super();
    this.id = nextWcId++;
    this.session = { on() {} };
  }
  setZoomFactor() {}
  setWindowOpenHandler() {}
  isDestroyed() { return false; }
}
class FakeWebContentsView {
  constructor() {
    this.webContents = new FakeWebContents();
  }
}

const electronPath = require.resolve('electron');
require.cache[electronPath] = {
  id: electronPath,
  filename: electronPath,
  loaded: true,
  exports: { WebContentsView: FakeWebContentsView },
};

const { registerBrowserView, isBrowserViewContents, views } = require('../browserView.cjs');

function makeFakeIpcMain() {
  const handlers = new Map();
  return {
    handle: (channel, fn) => handlers.set(channel, fn),
    on: (channel, fn) => handlers.set(channel, fn),
    invoke: (channel, payload) => handlers.get(channel)(null, payload),
  };
}

let ipcMain;
beforeEach(() => {
  ipcMain = makeFakeIpcMain();
  registerBrowserView({ mainWindow: { isDestroyed: () => true }, ipcMain });
});

test('destroyed handler does not throw when view.webContents is already undefined', async () => {
  const viewId = `t-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const result = await ipcMain.invoke('browser:create', { viewId, partition: 'sm-test' });
  expect(result.ok).toBe(true);

  const view = views.get(viewId);
  const wc = view.webContents;
  expect(isBrowserViewContents(wc.id)).toBe(true);

  // Simulate the real crash precondition: webContents already gone by the
  // time the 'destroyed' listener fires (e.g. on app quit).
  view.webContents = undefined;

  expect(() => wc.emit('destroyed')).not.toThrow();
  expect(isBrowserViewContents(wc.id)).toBe(false);
});

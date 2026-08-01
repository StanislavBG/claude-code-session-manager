/**
 * browserView-oauth-popup.test.cjs — regression test for Google (and other
 * identity-provider) OAuth login failing inside the Browser tab.
 *
 * Root cause: wc.setWindowOpenHandler() in browserView.cjs unconditionally
 * denied every window.open() popup, which kills Google's GIS/FedCM popup —
 * it needs a real window.opener to postMessage the credential back to. This
 * test asserts identity-provider popups get `{ action: 'allow', ... }` (a
 * real child window) while every other popup keeps the existing deny +
 * browser:open-tab-request behavior, and that a realistic Chrome
 * User-Agent (not Electron's default) is set on both the main view and the
 * popup's webContents.
 *
 * `electron` isn't installed as a runnable binary here, and browserView.cjs
 * pulls it in via a plain CJS `require` (not vite-node's ESM graph), so
 * `vi.mock('electron', ...)` doesn't intercept it. Instead we pre-seed
 * Node's own require cache for the resolved `electron` path with a fake
 * `WebContentsView`, the only export browserView.cjs actually uses — same
 * pattern as browserView-destroyed-handler.test.cjs.
 *
 * Run: timeout 300 npx vitest run src/main/__tests__/browserView-oauth-popup.test.cjs
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
    this.userAgent = null;
    this._windowOpenHandler = null;
  }
  setZoomFactor() {}
  setUserAgent(ua) { this.userAgent = ua; }
  setWindowOpenHandler(fn) { this._windowOpenHandler = fn; }
  isDestroyed() { return false; }
}
class FakeWebContentsView {
  constructor() {
    this.webContents = new FakeWebContents();
  }
}
class FakeBrowserWindow {
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

const { registerBrowserView, views, isBrowserViewContents } = require('../browserView.cjs');

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

test('main view webContents gets a real Chrome user-agent, not the Electron default', async () => {
  const viewId = `oauth-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await ipcMain.invoke('browser:create', { viewId, partition: 'sm-test' });
  const view = views.get(viewId);
  expect(view.webContents.userAgent).toBeTruthy();
  expect(view.webContents.userAgent).not.toMatch(/Electron/);
  expect(view.webContents.userAgent).toMatch(/Chrome\//);
});

test('setWindowOpenHandler allows identity-provider popups with a real child window and denies others', async () => {
  const viewId = `oauth2-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await ipcMain.invoke('browser:create', { viewId, partition: 'sm-test' });
  const view = views.get(viewId);
  const handler = view.webContents._windowOpenHandler;
  expect(typeof handler).toBe('function');

  const allowed = handler({ url: 'https://accounts.google.com/o/oauth2/v2/auth?foo=bar' });
  expect(allowed.action).toBe('allow');
  expect(allowed.overrideBrowserWindowOptions.webPreferences).toEqual({
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
  });

  const denied = handler({ url: 'https://example.com/some-popup' });
  expect(denied).toEqual({ action: 'deny' });
});

test('identity-provider popup child window gets a Chrome UA and cleans up on destroy', async () => {
  const viewId = `oauth3-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await ipcMain.invoke('browser:create', { viewId, partition: 'sm-test' });
  const view = views.get(viewId);

  const childWindow = new FakeBrowserWindow();
  view.webContents.emit('did-create-window', childWindow);

  expect(childWindow.webContents.userAgent).toBeTruthy();
  expect(childWindow.webContents.userAgent).toMatch(/Chrome\//);

  // The popup's webContents.id must be exempted from index.cjs's global
  // will-navigate lock the same way the main Browser view is — otherwise
  // the OAuth handshake this fix enables would immediately get nav-locked
  // shut once the popup tries to navigate through consent/callback pages.
  expect(isBrowserViewContents(childWindow.webContents.id)).toBe(true);

  expect(() => childWindow.webContents.emit('destroyed')).not.toThrow();
  expect(isBrowserViewContents(childWindow.webContents.id)).toBe(false);
});

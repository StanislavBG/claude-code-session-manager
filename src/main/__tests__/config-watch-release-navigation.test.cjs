/**
 * config-watch-release-navigation.test.cjs — bindWatchReleaseOnNavigation():
 * a did-start-navigation on the bound webContents releases every watch that
 * sender registered, using the id captured at registration. Regression for the
 * macOS uncaught "Cannot read properties of null (reading 'webContents')"
 * (v0.132.0): the listener must not depend on any outside reference (the
 * module-level mainWindow is nulled in 'closed' while the app stays alive).
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/config-watch-release-navigation.test.cjs
 */
'use strict';

import { test, expect, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const config = require('../config.cjs');

const cleanup = [];
afterEach(() => {
  config.closeAllWatchers();
  while (cleanup.length) fs.rmSync(cleanup.pop(), { recursive: true, force: true });
});

function tmpRoot() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sm-watchnav-')));
  cleanup.push(dir);
  config.addAllowedRoot(dir);
  return dir;
}

/** Fake webContents whose `id` throws once destroyed, like Electron's. */
function fakeWebContents(id) {
  const wc = new EventEmitter();
  let destroyed = false;
  Object.defineProperty(wc, 'id', {
    get() {
      if (destroyed) throw new TypeError('Object has been destroyed');
      return id;
    },
  });
  wc.destroy = () => { destroyed = true; };
  return wc;
}

test('did-start-navigation releases the watches registered for that sender only', () => {
  const dir = tmpRoot();
  const a = path.join(dir, 'a.json');
  const b = path.join(dir, 'b.json');
  config.watch([a, b], 41);
  config.watch([a], 42);
  expect(config.watchedPathsForSender(41).sort()).toEqual([a, b].sort());

  const wc = fakeWebContents(41);
  config.bindWatchReleaseOnNavigation(wc);
  wc.emit('did-start-navigation');

  expect(config.watchedPathsForSender(41)).toEqual([]);
  expect(config.watchedPathsForSender(42)).toEqual([a]);
});

test('still releases after every other reference is dropped and id access would throw', () => {
  const dir = tmpRoot();
  const a = path.join(dir, 'c.json');
  config.watch([a], 77);

  let holder = { win: { webContents: fakeWebContents(77) } };
  const wc = holder.win.webContents;
  config.bindWatchReleaseOnNavigation(wc);
  holder.win = null; // what createWindow's 'closed' handler does to mainWindow
  holder = null;
  wc.destroy();

  expect(() => wc.emit('did-start-navigation')).not.toThrow();
  expect(config.watchedPathsForSender(77)).toEqual([]);
});

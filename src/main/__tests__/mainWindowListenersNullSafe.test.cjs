/**
 * mainWindowListenersNullSafe.test.cjs — regression guard for the macOS
 * uncaughtException "Cannot read properties of null (reading 'webContents')"
 * (telemetry, v0.132.0, src/main/index.cjs did-start-navigation listener).
 *
 * The module-level `mainWindow` is nulled in its 'closed' handler while the app
 * stays alive on macOS, so any `webContents.on(...)` callback registered inside
 * createWindow() must use the webContents / window captured at registration,
 * never the module-level `mainWindow`. index.cjs requires electron, so this is
 * a source scan.
 *
 * Run: timeout 300 npx vitest run src/main/__tests__/mainWindowListenersNullSafe.test.cjs
 */

'use strict';

import { test, expect } from 'vitest';
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'index.cjs'), 'utf8');

/** Return the source of a brace-delimited block starting at the first `{` at/after `from`. */
function blockFrom(src, from) {
  const open = src.indexOf('{', from);
  if (open < 0) throw new Error('no opening brace');
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  throw new Error('unbalanced braces');
}

function createWindowBody() {
  const start = SRC.indexOf('function createWindow(');
  expect(start).toBeGreaterThanOrEqual(0);
  return blockFrom(SRC, start);
}

/** Every `<x>.webContents.on(` / `wc.on(` callback body inside createWindow. */
function listenerBodies(body) {
  const out = [];
  const re = /(?:\.webContents|\bwc)\.on\(\s*'([^']+)'\s*,/g;
  let m;
  while ((m = re.exec(body))) {
    // Callback body: first `{` after the arrow / function keyword.
    const arrow = body.indexOf('=>', re.lastIndex);
    const fnKw = body.indexOf('function', re.lastIndex);
    const at = [arrow, fnKw].filter((n) => n >= 0).sort((a, b) => a - b)[0];
    out.push({ event: m[1], body: blockFrom(body, at) });
  }
  return out;
}

test('createWindow registers webContents listeners (scan is not vacuous)', () => {
  const events = listenerBodies(createWindowBody()).map((l) => l.event);
  expect(events).toEqual(expect.arrayContaining(['did-start-navigation', 'will-frame-navigate', 'context-menu']));
});

test('no webContents.on callback in createWindow dereferences module-level mainWindow', () => {
  const offenders = listenerBodies(createWindowBody())
    .filter((l) => /\bmainWindow\b/.test(l.body))
    .map((l) => l.event);
  expect(offenders).toEqual([]);
});

test('did-start-navigation releases watches for the captured webContents id', () => {
  const l = listenerBodies(createWindowBody()).find((x) => x.event === 'did-start-navigation');
  expect(l).toBeDefined();
  expect(l.body).toMatch(/releaseWatchesForSender\(\s*wc\.id\s*\)/);
});

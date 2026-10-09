/**
 * configWatchDepth.test.cjs — watch(paths, senderId, { depth }) opts into a
 * non-recursive chokidar watch; the default stays recursive.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/configWatchDepth.test.cjs
 */
'use strict';

import { test, expect, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const config = require('../config.cjs');

const cleanup = [];
afterEach(() => {
  config.closeAllWatchers();
  while (cleanup.length) fs.rmSync(cleanup.pop(), { recursive: true, force: true });
});

function setup() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sm-watchdepth-')));
  cleanup.push(dir);
  fs.mkdirSync(path.join(dir, 'sub'));
  config.addAllowedRoot(dir);
  const events = [];
  config.attachWindow({
    isDestroyed: () => false,
    webContents: {
      isDestroyed: () => false,
      isCrashed: () => false,
      send: (ch, payload) => { if (ch === 'config:changed') events.push(payload); },
    },
  });
  return { dir, events };
}

async function waitFor(pred, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return pred();
}

const settle = () => new Promise((r) => setTimeout(r, 300));

test('depth 0: direct child emits, nested child does not', async () => {
  const { dir, events } = setup();
  config.watch([dir], 1, { depth: 0 });
  await settle();
  fs.writeFileSync(path.join(dir, 'sub', 'deep.txt'), 'x');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'x');
  expect(await waitFor(() => events.some((e) => e.path === dir))).toBe(true);
  await settle();
  expect(events.every((e) => e.path === dir)).toBe(true);
  expect(events.length).toBe(1);
  config.unwatch([dir], 1, { depth: 0 });
});

test('no opts: nested create still emits (recursive default)', async () => {
  const { dir, events } = setup();
  config.watch([dir], 1);
  await settle();
  fs.writeFileSync(path.join(dir, 'sub', 'deep.txt'), 'x');
  expect(await waitFor(() => events.some((e) => e.path === dir))).toBe(true);
  config.unwatch([dir], 1);
});

test('recursive and depth-0 watches are separate refcounted watchers; unwatch with same opts releases the match', async () => {
  const { dir, events } = setup();
  config.watch([dir], 1);
  config.watch([dir], 1, { depth: 0 });
  config.unwatch([dir], 1);
  await settle();
  fs.writeFileSync(path.join(dir, 'sub', 'deep.txt'), 'x');
  await settle();
  expect(events.length).toBe(0); // recursive one closed; depth-0 still ignores nested
  fs.writeFileSync(path.join(dir, 'a.txt'), 'x');
  expect(await waitFor(() => events.length > 0)).toBe(true);
  config.unwatch([dir], 1, { depth: 0 });
  await settle();
  const n = events.length;
  fs.writeFileSync(path.join(dir, 'b.txt'), 'x');
  await settle();
  expect(events.length).toBe(n);
});

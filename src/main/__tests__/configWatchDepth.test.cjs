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

// Chokidar exposes no ready hook through config.watch, and ignoreInitial drops
// anything written before its scan finishes. A fixed settle() is therefore a
// race under CPU load. Probe instead: rewrite a file until the watcher reports.
async function untilWatching(dir, events) {
  // A fresh file every 250ms: constant rewrites would keep resetting
  // awaitWriteFinish's stability window and never emit.
  const end = Date.now() + 12000;
  let n = 0;
  while (events.length === 0 && Date.now() < end) {
    fs.writeFileSync(path.join(dir, `probe-${n++}.txt`), 'x');
    await waitFor(() => events.length > 0, 250);
  }
  expect(events.length).toBeGreaterThan(0);
  await new Promise((r) => setTimeout(r, 400)); // drain in-flight probe events
  events.length = 0;
}

test('recursive and depth-0 watches are separate refcounted watchers; unwatch with same opts releases the match', async () => {
  const { dir, events } = setup();
  config.watch([dir], 1);
  config.watch([dir], 1, { depth: 0 });
  config.unwatch([dir], 1);
  // Only the depth-0 watcher remains; wait until it is actually live.
  await untilWatching(dir, events);
  // Nested write first, direct write second: the direct event is the barrier.
  fs.writeFileSync(path.join(dir, 'sub', 'deep.txt'), 'x');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'x');
  expect(await waitFor(() => events.length > 0, 10000)).toBe(true);
  await settle();
  expect(events.length).toBe(1); // recursive one closed: nested write never emitted
  config.unwatch([dir], 1, { depth: 0 });
  await settle();
  const n = events.length;
  fs.writeFileSync(path.join(dir, 'b.txt'), 'x');
  await settle();
  expect(events.length).toBe(n);
}, 30000);

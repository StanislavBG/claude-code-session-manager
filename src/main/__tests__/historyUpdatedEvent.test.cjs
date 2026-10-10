/**
 * historyUpdatedEvent.test.cjs — historyAggregator broadcasts a throttled
 * `history:updated` after a rollup append that wrote entries.
 *
 * Run: timeout 300 npx vitest run src/main/__tests__/historyUpdatedEvent.test.cjs
 */

'use strict';

import { test, expect, beforeEach, afterEach, vi } from 'vitest';
const path = require('node:path');
const Module = require('node:module');

const sends = [];
let sendImpl = (win, channel) => { sends.push(channel); };
const fakeWin = {};

function stub(rel, exports) {
  const p = require.resolve(rel);
  const m = new Module(p);
  m.filename = p; m.loaded = true; m.exports = exports;
  require.cache[p] = m;
}

stub('../lib/sendToRenderer.cjs', { sendIfAlive: (...a) => sendImpl(...a) });
const electronPath = require.resolve('electron');
const em = new Module(electronPath);
em.filename = electronPath; em.loaded = true;
em.exports = { ipcMain: { handle() {}, on() {} }, BrowserWindow: { getAllWindows: () => [fakeWin] } };
require.cache[electronPath] = em;
delete require.cache[path.resolve(__dirname, '../historyAggregator.cjs')];

const historyRollup = require('../lib/historyRollup.cjs');
const agg = require('../historyAggregator.cjs');
const origAppend = historyRollup.appendRollupDays;

beforeEach(() => {
  vi.useFakeTimers();
  sends.length = 0;
  sendImpl = (win, channel) => { sends.push(channel); };
  historyRollup.appendRollupDays = vi.fn(async () => {});
});

afterEach(async () => {
  await vi.advanceTimersByTimeAsync(20000); // drain throttle state between tests
  vi.useRealTimers();
  historyRollup.appendRollupDays = origAppend;
});

test('one append with entries gives one event', async () => {
  await agg.appendRollupAndNotify([{ d: 1 }]);
  await vi.advanceTimersByTimeAsync(6000);
  expect(sends).toEqual(['history:updated']);
});

test('10 appends within 5s give leading and trailing events only', async () => {
  for (let i = 0; i < 10; i++) await agg.appendRollupAndNotify([{ d: i }]);
  expect(sends).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(5000);
  expect(sends).toHaveLength(2);
  await vi.advanceTimersByTimeAsync(10000);
  expect(sends).toHaveLength(2);
});

test('append with zero entries gives no event', async () => {
  await agg.appendRollupAndNotify([]);
  await vi.advanceTimersByTimeAsync(6000);
  expect(sends).toHaveLength(0);
});

test('a throwing send does not reject aggregation', async () => {
  sendImpl = () => { throw new Error('boom'); };
  await expect(agg.appendRollupAndNotify([{ d: 1 }])).resolves.toBeUndefined();
});

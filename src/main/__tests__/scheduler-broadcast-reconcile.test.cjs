/**
 * scheduler-broadcast-reconcile.test.cjs — broadcast() used to do its own bare
 * `readQueue() -> reconcile(state) -> writeQueue(state)` BEFORE ever touching
 * the broadcastCoalescer, so a burst of N broadcast() calls inside one
 * BROADCAST_COALESCE_MS window cost N full reconcile passes + N queue writes
 * to produce ONE coalesced payload — and did so outside mutate()'s lock, so a
 * concurrent mutation's update could be lost. The fix moves the
 * reconcile+write pair inside the coalescer's `getPayload`, run through
 * `mutate()`, so N broadcast() calls in one window cost exactly one reconcile
 * and one write.
 *
 * `reconcile` is a bare local call inside getPayload's mutate() callback, so
 * — matching this file's existing testable-seam convention (module.exports.
 * stashList / evaluateSharedTreeGuard / committedInWindow) — it is invoked as
 * `module.exports.reconcile(state)` specifically so tests can spy on it here.
 * `queueStore.readMerged`/`writeSplit` are genuine cross-module property
 * calls already, so they're spied on directly with no source change needed.
 *
 * HOME-isolated (mirrors reconcileFlatPrdSweep.test.cjs): stub HOME to a
 * mkdtemp dir before requiring scheduler.cjs so `ensureDirs()` (called by the
 * real `writeQueue()` wrapper before the now-mocked `queueStore.writeSplit`)
 * never touches the real machine.
 *
 * Run: timeout 60 npx vitest run src/main/__tests__/scheduler-broadcast-reconcile.test.cjs
 */
'use strict';

import { test, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let tmpHome;
let originalHome;
let scheduler;
let queueStore;

beforeAll(() => {
  originalHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-broadcast-reconcile-home-'));
  process.env.HOME = tmpHome;

  scheduler = require('../scheduler.cjs');
  queueStore = require('../lib/queueStore.cjs');

  if (!scheduler.PRDS_DIR.startsWith(tmpHome)) {
    throw new Error(`refusing to run: PRDS_DIR (${scheduler.PRDS_DIR}) is not under the temp HOME (${tmpHome})`);
  }
});

afterAll(() => {
  process.env.HOME = originalHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

function freshState() {
  return { config: {}, jobs: [], scheduledFor: null, lastRunAt: null, paused: null };
}

function fakeWindow() {
  return {
    isDestroyed: () => false,
    webContents: { isDestroyed: () => false, isCrashed: () => false, send: vi.fn() },
  };
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

afterEach(() => {
  vi.restoreAllMocks();
  scheduler.attachWindow(null);
});

test('10 broadcast() calls inside one coalesce window trigger exactly one reconcile and one queue write', async () => {
  vi.spyOn(queueStore, 'readMerged').mockImplementation(async () => freshState());
  const writeSpy = vi.spyOn(queueStore, 'writeSplit').mockResolvedValue(undefined);
  const reconcileSpy = vi.spyOn(scheduler, 'reconcile').mockResolvedValue(undefined);

  for (let i = 0; i < 10; i += 1) scheduler.broadcast();

  // BROADCAST_COALESCE_MS is 200ms; give the trailing-edge timer room to fire.
  await wait(400);

  expect(reconcileSpy).toHaveBeenCalledTimes(1);
  expect(writeSpy).toHaveBeenCalledTimes(1);
});

test('a window-less (flush) broadcast() still reconciles, even with no window attached', async () => {
  scheduler.attachWindow(null);
  vi.spyOn(queueStore, 'readMerged').mockImplementation(async () => freshState());
  const writeSpy = vi.spyOn(queueStore, 'writeSplit').mockResolvedValue(undefined);
  const reconcileSpy = vi.spyOn(scheduler, 'reconcile').mockResolvedValue(undefined);

  await scheduler.broadcast({ flush: true });

  expect(reconcileSpy).toHaveBeenCalledTimes(1);
  expect(writeSpy).toHaveBeenCalledTimes(1);
});

test('a reconcile() that throws does not wedge the coalescer — the next broadcast() still sends', async () => {
  const win = fakeWindow();
  scheduler.attachWindow(win);
  vi.spyOn(queueStore, 'readMerged').mockImplementation(async () => freshState());
  vi.spyOn(queueStore, 'writeSplit').mockResolvedValue(undefined);
  const reconcileSpy = vi.spyOn(scheduler, 'reconcile')
    .mockRejectedValueOnce(new Error('boom'))
    .mockResolvedValue(undefined);

  scheduler.broadcast();
  await wait(400);
  expect(win.webContents.send).not.toHaveBeenCalled();

  scheduler.broadcast();
  await wait(400);

  expect(reconcileSpy).toHaveBeenCalledTimes(2);
  expect(win.webContents.send).toHaveBeenCalledTimes(1);
  expect(win.webContents.send).toHaveBeenCalledWith('schedule:state', expect.any(Object));
});

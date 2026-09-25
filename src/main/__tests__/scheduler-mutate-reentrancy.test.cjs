/**
 * scheduler-mutate-reentrancy.test.cjs — regression cover for PRD 1443.
 *
 * mutate()'s chain (`mutateTail = mutateTail.then(...)`) is the single-writer
 * lock over queue.json. Calling mutate() again from INSIDE a still-running
 * mutate body (and awaiting it) used to queue the inner call behind
 * mutateTail — which the outer call itself is holding — so the inner
 * `await` never resolved and the whole scheduler froze (PRD 1442 was the one
 * known path: reconcile -> autoArchiveCompleted -> retireCompletedSlugs ->
 * mutate). The fix tracks "am I inside a live mutate body" via
 * AsyncLocalStorage and rejects immediately on re-entry instead of
 * deadlocking.
 *
 * HOME-isolated (mirrors scheduler-broadcast-reconcile.test.cjs): stub HOME to
 * a mkdtemp dir and mock queueStore's read/write so this never touches real
 * queue.json.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/scheduler-mutate-reentrancy.test.cjs
 */
'use strict';

import { test, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let tmpHome;
let originalHome;
let scheduler;
let queueStore;

beforeAll(() => {
  originalHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-mutate-reentrancy-home-'));
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

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

afterEach(() => {
  vi.restoreAllMocks();
});

test('nested awaited mutate rejects instead of hanging', async () => {
  vi.spyOn(queueStore, 'readMerged').mockImplementation(async () => freshState());
  vi.spyOn(queueStore, 'writeSplit').mockResolvedValue(undefined);

  let innerRejection = null;
  const outerPromise = scheduler._mutateForTests(async () => {
    try {
      await scheduler._mutateForTests(async () => 'inner-should-never-resolve');
    } catch (err) {
      innerRejection = err;
    }
    return 'outer-done';
  });

  const result = await Promise.race([
    outerPromise,
    wait(2000).then(() => { throw new Error('outer mutate did not settle within 2s'); }),
  ]);

  expect(result).toBe('outer-done');
  expect(innerRejection).toBeInstanceOf(Error);
  expect(innerRejection.message).toMatch(/re-entered/i);
});

test('mutate scheduled via setTimeout from a finished body runs normally', async () => {
  vi.spyOn(queueStore, 'readMerged').mockImplementation(async () => freshState());
  vi.spyOn(queueStore, 'writeSplit').mockResolvedValue(undefined);

  let deferredResult = null;
  let deferredError = null;

  await scheduler._mutateForTests(async () => {
    setTimeout(() => {
      scheduler._mutateForTests(async () => 'deferred-ok')
        .then((r) => { deferredResult = r; })
        .catch((err) => { deferredError = err; });
    }, 10);
    return 'immediate';
  });

  await wait(300);

  expect(deferredError).toBeNull();
  expect(deferredResult).toBe('deferred-ok');
});

test('sequential mutates unaffected', async () => {
  vi.spyOn(queueStore, 'readMerged').mockImplementation(async () => freshState());
  vi.spyOn(queueStore, 'writeSplit').mockResolvedValue(undefined);

  const r1 = await scheduler._mutateForTests(async () => 'first');
  const r2 = await scheduler._mutateForTests(async () => 'second');

  expect(r1).toBe('first');
  expect(r2).toBe('second');
});

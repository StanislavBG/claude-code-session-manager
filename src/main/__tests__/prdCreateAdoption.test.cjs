/**
 * prdCreateAdoption.test.cjs — PRD 1446: scheduler_create_prd wrote a PRD
 * file and promised its queue row "on the next reconcile pass (~1 minute)",
 * but nothing reliably ran that pass. The 60s pollLoop only reaches
 * reconcile() via maybeLaunchWhenAvailable, which returns early while zero
 * rows are pending; the 10-minute rescheduleTimer awaits refreshNextReset()
 * -> billing.fetchUsage() BEFORE reconciling, and stalled indefinitely while
 * the usage meter was rate-limited (PRDs 1420-1441 sat unadopted 17+
 * minutes, 2026-09-25).
 *
 * Two fixes, exercised here:
 *  1. scheduler.remote gained `requestReconcile()` — the SAME broadcast
 *     coalescer / reconcile() seam `remote.resetJob` already used (no
 *     second reconcile implementation) — and prdCreate.cjs's createPrd()
 *     calls it right after a successful write.
 *  2. rescheduleTimer's refreshNextReset() await is now bounded by a
 *     RESCHEDULE_TIMER_BILLING_RACE_MS Promise.race against the cached
 *     reset value, so its own mutate(reconcile) still runs even when
 *     billing.fetchUsage() never resolves.
 *
 * HOME-isolated + fixture-project pattern mirrors reconcileTiming.test.cjs.
 *
 * Run: timeout 300 npx vitest run src/main/__tests__/prdCreateAdoption.test.cjs
 */

'use strict';

import {
  test, expect, beforeAll, afterAll, afterEach, vi,
} from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let tmpHome;
let originalHome;
let scheduler;
let usage;
let config;
let createPrd;

/** A bare cwd for the fake-remote createPrd() tests below — these don't go
 *  through a real Epic/queue, so all they need is a directory config.cjs's
 *  validatePath will accept. Not os.homedir(): this file's beforeAll swaps
 *  process.env.HOME for scheduler.cjs's isolation, so os.homedir() called
 *  from inside a test would resolve to tmpHome instead of the real home
 *  config.cjs's allowedRoots snapshot was seeded with at import time. */
function makeAllowedCwd(prefix) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  config.addAllowedRoot(cwd);
  return cwd;
}

beforeAll(() => {
  originalHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-prd-adoption-home-'));
  process.env.HOME = tmpHome;

  // Required AFTER HOME is swapped, never at module top level: activeSessions.cjs
  // (pulled in transitively by prdCreate.cjs/scheduler.cjs) snapshots
  // `os.homedir()` into a module-scope constant at first require — loading it
  // before this reassignment would permanently bake in the vitest sandbox's
  // own HOME (tests/setup/schedulerSandbox.globalSetup.cjs) instead of this
  // file's tmpHome, silently breaking every ~/.claude/projects-scan-dependent
  // assertion below (allProjectCwds/reconcile would always come back empty).
  scheduler = require('../scheduler.cjs');
  usage = require('../usage.cjs');
  config = require('../config.cjs');
  ({ createPrd } = require('../lib/prdCreate.cjs'));

  if (!scheduler.PRDS_DIR.startsWith(tmpHome)) {
    throw new Error(`refusing to run: PRDS_DIR (${scheduler.PRDS_DIR}) is not under the temp HOME (${tmpHome})`);
  }
});

afterAll(() => {
  process.env.HOME = originalHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function registerActiveProject(cwd) {
  const projectsDir = path.join(tmpHome, '.claude', 'projects');
  const slugDir = path.join(projectsDir, `fake-project-slug-${path.basename(cwd)}`);
  fs.mkdirSync(slugDir, { recursive: true });
  fs.writeFileSync(path.join(slugDir, 'transcript.jsonl'), `${JSON.stringify({ cwd })}\n`);
}

function makeFixtureProject(prefix) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  registerActiveProject(cwd);
  return cwd;
}

function writeCanonicalPrd(cwd, epicId, slug) {
  const epicPrdsDir = path.join(cwd, 'session-manager-operations', 'scheduler', 'epics', epicId, 'prds');
  fs.mkdirSync(epicPrdsDir, { recursive: true });
  fs.writeFileSync(
    path.join(epicPrdsDir, `${slug}.md`),
    `---\ntitle: Adoption fixture\ncwd: ${cwd}\nestimateMinutes: 10\nsourcePromptId: ${epicId}\ncreatedVia: scheduler-api\nissuedAt: 2026-09-25T00:00:00.000Z\n---\n\n# Goal\n\nSomething.\n`,
    'utf8',
  );
}

test('remote.requestReconcile() adopts a freshly-created PRD into a pending row with no tickQueue call', async () => {
  const cwd = makeFixtureProject('sm-prd-adoption-fresh-');
  writeCanonicalPrd(cwd, 'epic-fresh', '9001-fresh');

  const tickQueueSpy = vi.spyOn(scheduler, 'tickQueue');

  await scheduler.remote.requestReconcile();

  expect(tickQueueSpy).not.toHaveBeenCalled();
  const job = await scheduler.remote.getJob('9001-fresh');
  expect(job).not.toBeNull();
  expect(job.status).toBe('pending');
});

test('createPrd() calls remote.requestReconcile() once after a successful write and reports enqueued:true once the row exists', async () => {
  const writes = new Map();
  const requestReconcile = vi.fn(async () => {});
  const remote = {
    async allocateParallelGroup() { return '9002'; },
    async readPrd(slug) {
      return writes.has(slug) ? { ok: true, text: writes.get(slug) } : { ok: false, error: 'missing' };
    },
    async writePrd(slug, body) {
      writes.set(slug, body);
      return { ok: true, path: `/fake/${slug}.md` };
    },
    async listPrds() { return { prds: [], total: 0, limit: 0, offset: 0, hasMore: false }; },
    requestReconcile,
    // Simulates the reconcile pass having already produced the queue row by
    // the time createPrd() checks for it.
    async getJob(slug) { return writes.has(slug) ? { slug, status: 'pending' } : null; },
  };

  const result = await createPrd({
    title: 'Adoption wiring check',
    cwd: makeAllowedCwd('sm-prd-adoption-hit-'),
    estimateMinutes: 10,
    goal: 'g',
    acceptanceCriteria: ['a'],
    implementationNotes: 'n',
  }, remote);

  expect(result.ok).toBe(true);
  expect(requestReconcile).toHaveBeenCalledTimes(1);
  expect(result.enqueued).toBe(true);
  expect(result.note).not.toMatch(/derived by the next scheduler reconcile pass/);
});

test('createPrd() reports enqueued:false with the deferred-pass note when the row is not visible right after reconcile', async () => {
  const writes = new Map();
  const requestReconcile = vi.fn(async () => {});
  const remote = {
    async allocateParallelGroup() { return '9003'; },
    async readPrd(slug) {
      return writes.has(slug) ? { ok: true, text: writes.get(slug) } : { ok: false, error: 'missing' };
    },
    async writePrd(slug, body) {
      writes.set(slug, body);
      return { ok: true, path: `/fake/${slug}.md` };
    },
    async listPrds() { return { prds: [], total: 0, limit: 0, offset: 0, hasMore: false }; },
    requestReconcile,
    async getJob() { return null; },
  };

  const result = await createPrd({
    title: 'Adoption wiring miss',
    cwd: makeAllowedCwd('sm-prd-adoption-miss-'),
    estimateMinutes: 10,
    goal: 'g',
    acceptanceCriteria: ['a'],
    implementationNotes: 'n',
  }, remote);

  expect(result.ok).toBe(true);
  expect(requestReconcile).toHaveBeenCalledTimes(1);
  expect(result.enqueued).toBe(false);
  expect(result.note).toMatch(/derived by the next scheduler reconcile pass/);
});

test('rescheduleTimer still reconciles when billing.fetchUsage() never resolves', async () => {
  const cwd = makeFixtureProject('sm-prd-adoption-stall-');
  writeCanonicalPrd(cwd, 'epic-stall', '9004-stall');

  vi.spyOn(usage, 'fetchUsage').mockImplementation(() => new Promise(() => {}));
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

  const pending = scheduler.rescheduleTimer();
  await vi.advanceTimersByTimeAsync(scheduler.RESCHEDULE_TIMER_BILLING_RACE_MS);
  await pending;

  vi.useRealTimers();

  const job = await scheduler.remote.getJob('9004-stall');
  expect(job).not.toBeNull();
  expect(job.status).toBe('pending');
}, 15_000);

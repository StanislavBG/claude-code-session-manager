/**
 * pollLoop-dispatch-on-failure.test.cjs — PRD: 27 pending jobs across two
 * projects sat at 0 running for days while every surface reported healthy.
 * Root cause: under firePolicy 'when-available', maybeLaunchWhenAvailable()
 * (the only thing that ever calls tickQueue() on the poll timer) was reached
 * from exactly two of pollLoop()'s branches — 'ok' and 'meter_rate_limited'.
 * The auth branch, the transient/config branch, and the outer catch all
 * incremented consecutiveFailures and returned WITHOUT attempting a
 * dispatch, so a poller that started failing (for any reason) silently
 * stopped driving the queue even though slots/memory/utilization were fine.
 *
 * This suite drives the REAL pollLoop() (not a reimplementation) through a
 * transient billing failure and a thrown error, and asserts a dispatch was
 * actually attempted in both cases — observed via `lastDispatchAttemptAt`,
 * which tickQueue() stamps the moment it reaches the picker, independent of
 * whether that pass ends in an actual job launch (see classifyQueueStarvation's
 * header for why this must be distinct from `lastRunAt`).
 *
 * Usage-meter circuit PRD update: pollLoop no longer fires blind at a hard-
 * coded cachedUtilization=0 on failure — it falls back to
 * usageCircuit.degradedBudget(), which carries forward the last known-good
 * BINDING window's utilization (or conservatively assumes 100/no-headroom
 * when there's no known-good reading yet at all). So each test below first
 * drives ONE successful ('ok') poll — with the queue still empty, so it
 * can't itself cause a dispatch — to seed that known-good low-utilization
 * reading, THEN seeds the pending job and drives the failure. This proves
 * dispatch proceeds under the CARRIED-FORWARD degraded budget, not a blind 0.
 *
 * No existing test in this repo mocks a module import (see
 * pty-epic-worktree-spawn-cwd.test.cjs's header) — this monkey-patches
 * usage.cjs's cached module object directly instead, same pattern.
 *
 * Run: timeout 180 npx vitest run src/main/__tests__/pollLoop-dispatch-on-failure.test.cjs
 */

'use strict';

import { test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let tmpHome;
let originalHome;
let scheduler;
let queueStore;
let billing;
let originalFetchUsage;

beforeAll(() => {
  originalHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-pollloop-dispatch-'));
  process.env.HOME = tmpHome;
  fs.mkdirSync(path.join(tmpHome, '.claude', 'session-manager'), { recursive: true });
  fs.mkdirSync(path.join(tmpHome, '.claude', 'projects'), { recursive: true });
  scheduler = require('../scheduler.cjs');
  queueStore = require('../lib/queueStore.cjs');
  billing = require('../usage.cjs');
  originalFetchUsage = billing.fetchUsage;
});

afterAll(() => {
  billing.fetchUsage = originalFetchUsage;
  process.env.HOME = originalHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

afterEach(() => {
  billing.fetchUsage = originalFetchUsage;
  delete process.env.SM_E2E;
  delete process.env.SM_MOCK_BILLING_KIND;
});

// allProjectCwds()/activeProjectCwds() (queueStore.cjs's stateCwds) discover
// project cwds by scanning ~/.claude/projects/*/*.jsonl for a `cwd` field —
// fake one project transcript pointing at the fixture cwd, same pattern as
// prdAdminRoutes.test.cjs / scheduler-verify-prd-path.test.cjs.
function mkProject() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-pollloop-project-'));
  const slug = `9001-pollloop-dispatch-${process.pid}-${Math.floor(Math.random() * 1e6)}`;
  const projDir = fs.mkdtempSync(path.join(tmpHome, '.claude', 'projects', 'sm-pollloop-fake-'));
  fs.writeFileSync(path.join(projDir, 'session.jsonl'), `${JSON.stringify({ cwd })}\n`, 'utf8');
  return { cwd, slug };
}

// dependsOn deliberately references a slug that can never resolve (no such
// row, no history/archive entry) so pickNextBatch's dep gate holds this job
// forever instead of ever handing it to spawnJob. tickQueue() still reaches
// the picker and stamps lastDispatchAttemptAt (that stamp is unconditional —
// see lastDispatchAttemptAt's own header comment), which is the only thing
// these tests assert on. Without this, the picker actually dispatches the
// job: spawnJob() is fire-and-forget (scheduler.cjs's own comment: "spawnJob
// is fire-and-forget; it calls tickQueue() on completion") and its real
// child-process exit handler later calls mutate() independently of the
// tickTail chain flushPendingTick() drains — round-tripping whatever
// lastDispatchAttemptAt was in memory at ITS read time. Reproduced outside
// vitest: that stray write landed ~2s after this suite's own reset-to-null,
// clobbering the NEXT test's "still null" assertion with the previous test's
// stamp. A held (never-dispatched) job has no such background continuation.
async function seedOnePendingJob() {
  const { cwd, slug } = mkProject();
  await scheduler.writeQueue({
    jobs: [{ slug, title: 'x', cwd, status: 'pending', dependsOn: ['unresolvable-dep-never-completes'] }],
    config: {},
    paused: null,
  });
  return { cwd, slug };
}

async function lastDispatchAttemptAt() {
  return queueStore.readMergedSync().lastDispatchAttemptAt;
}

// After pollLoop() fires maybeLaunchWhenAvailable() fire-and-forget, the tick
// it enqueues lands on the shared, serialized tickTail chain that tickQueue()
// itself maintains. A follow-up tickQueue() call is appended to that SAME
// chain, so awaiting it guarantees the earlier tick (if any was enqueued)
// has already settled.
async function flushPendingTick() {
  await scheduler.tickQueue();
}

test('pollLoop still attempts a dispatch after a transient billing failure, using the degraded budget (not utilization 0)', async () => {
  // Seed a known-good low-utilization reading via an 'ok' poll first.
  process.env.SM_E2E = '1';
  process.env.SM_MOCK_BILLING_KIND = 'ok';
  await scheduler.pollLoop();
  // A prior test's leftover project (a REAL, still-registered project cwd —
  // readQueue() merges every such cwd) can still hold its own permanently-
  // pending job, so this seed poll's own maybeLaunchWhenAvailable may itself
  // spawn a fire-and-forget tick; drain it before resetting/reseeding so
  // that stray tick's async mutate() can't land AFTER (and clobber) the
  // reset below.
  await flushPendingTick();
  await scheduler.writeQueue({ jobs: [], config: {}, paused: null });

  await seedOnePendingJob();
  expect(await lastDispatchAttemptAt()).toBeNull();

  process.env.SM_MOCK_BILLING_KIND = 'transient';
  await scheduler.pollLoop();
  await flushPendingTick();

  expect(await lastDispatchAttemptAt()).not.toBeNull();
});

test('pollLoop still attempts a dispatch after the billing poll throws, using the degraded budget (not utilization 0)', async () => {
  process.env.SM_E2E = '1';
  process.env.SM_MOCK_BILLING_KIND = 'ok';
  await scheduler.pollLoop(); // seed a known-good low-utilization reading
  await flushPendingTick();
  await scheduler.writeQueue({ jobs: [], config: {}, paused: null });

  await seedOnePendingJob();
  expect(await lastDispatchAttemptAt()).toBeNull();

  delete process.env.SM_E2E;
  delete process.env.SM_MOCK_BILLING_KIND;
  billing.fetchUsage = async () => { throw new Error('simulated IPC transport failure'); };
  await scheduler.pollLoop();
  await flushPendingTick();

  expect(await lastDispatchAttemptAt()).not.toBeNull();
});

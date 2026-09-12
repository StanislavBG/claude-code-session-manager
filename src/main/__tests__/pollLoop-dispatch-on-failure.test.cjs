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

async function seedOnePendingJob() {
  const { cwd, slug } = mkProject();
  await scheduler.writeQueue({
    jobs: [{ slug, title: 'x', cwd, status: 'pending', dependsOn: [] }],
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

test('pollLoop still attempts a dispatch after a transient billing failure', async () => {
  await seedOnePendingJob();
  expect(await lastDispatchAttemptAt()).toBeNull();

  process.env.SM_E2E = '1';
  process.env.SM_MOCK_BILLING_KIND = 'transient';
  await scheduler.pollLoop();
  await flushPendingTick();

  expect(await lastDispatchAttemptAt()).not.toBeNull();
});

test('pollLoop still attempts a dispatch after the billing poll throws', async () => {
  await seedOnePendingJob();
  expect(await lastDispatchAttemptAt()).toBeNull();

  billing.fetchUsage = async () => { throw new Error('simulated IPC transport failure'); };
  await scheduler.pollLoop();
  await flushPendingTick();

  expect(await lastDispatchAttemptAt()).not.toBeNull();
});

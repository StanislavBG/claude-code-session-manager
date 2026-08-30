/**
 * scheduler-autofix-outcome.test.cjs — self-heal terminal-state gap fix.
 *
 * spawnInvestigation's onExit used to stamp autoFixOutcome only in the
 * no-plan branch; a job whose probe erred, spawn-failed, or produced a plan
 * that never became a queue row ended up autoFixAttempted:true with no
 * outcome — permanently excluded from both retry AND the exhausted-retry
 * annotation. This file is a vitest-runnable (npm run test:unit) home for
 * the scenarios the PRD's acceptance criteria enumerate; the pure-logic
 * coverage in scheduler-autofix-select.test.cjs (node --test) exercises the
 * same helpers in more granular detail.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/scheduler-autofix-outcome.test.cjs
 */

'use strict';

import { test, expect } from 'vitest';
const {
  selectAutoFixTargets, isExhaustedAutoFix, isPlanUnqueued, fixSlugFor,
} = require('../scheduler.cjs');

const noSiblingOnDisk = () => false;

function makeJob(overrides = {}) {
  return {
    slug: '05-my-feature',
    status: 'needs_review',
    runId: '2026-06-16T10-00-00-000Z',
    parallelGroup: 5,
    ...overrides,
  };
}

function isTarget(job) {
  return selectAutoFixTargets([job], { fixSlugExists: noSiblingOnDisk }).some((j) => j.slug === job.slug);
}

function isAnnotatable(job, queuedSlugs = new Set()) {
  return isExhaustedAutoFix(job) || isPlanUnqueued(job, queuedSlugs);
}

// (a) attempted + no outcome → eligible once, then annotated when the retry is spent.
test('(a) attempted with unstamped outcome and an unspent retry is eligible, not annotated', () => {
  const job = makeJob({ autoFixAttempted: true, autoFixRetries: 0 });
  expect(isTarget(job)).toBe(true);
  expect(isAnnotatable(job)).toBe(false);
});

test('(a) attempted with unstamped outcome and a spent retry is annotated, not eligible', () => {
  const job = makeJob({ autoFixAttempted: true, autoFixRetries: 1 });
  expect(isTarget(job)).toBe(false);
  expect(isAnnotatable(job)).toBe(true);
});

// (b) outcome 'error' → eligible once.
test("(b) outcome 'error' with an unspent retry is eligible", () => {
  const job = makeJob({ autoFixAttempted: true, autoFixOutcome: 'error', autoFixRetries: 0 });
  expect(isTarget(job)).toBe(true);
  expect(isAnnotatable(job)).toBe(false);
});

test("(b) outcome 'error' with a spent retry is annotated, not eligible", () => {
  const job = makeJob({ autoFixAttempted: true, autoFixOutcome: 'error', autoFixRetries: 1 });
  expect(isTarget(job)).toBe(false);
  expect(isAnnotatable(job)).toBe(true);
});

// (c) outcome 'plan' with no queue row → annotated autofix_plan_unqueued, NOT retried.
test("(c) outcome 'plan' with the fix slug absent from the queue is annotated, never retried", () => {
  const job = makeJob({ autoFixAttempted: true, autoFixOutcome: 'plan', autoFixRetries: 0 });
  expect(isTarget(job)).toBe(false);
  expect(isPlanUnqueued(job, new Set())).toBe(true);
  expect(isExhaustedAutoFix(job)).toBe(false);
});

// (d) outcome 'plan' WITH a queue row → neither retried nor annotated.
test("(d) outcome 'plan' with the fix slug present in the queue is neither retried nor annotated", () => {
  const job = makeJob({ autoFixAttempted: true, autoFixOutcome: 'plan', autoFixRetries: 0 });
  const queuedSlugs = new Set([fixSlugFor(job)]);
  expect(isTarget(job)).toBe(false);
  expect(isAnnotatable(job, queuedSlugs)).toBe(false);
});

// (invariant) every needs_review job is either an auto-fix target or
// annotatable (would receive a non-null verifierVerdict) — never both false.
test('invariant: fresh, retry-eligible, exhausted, and plan-unqueued jobs are always selected or annotatable', () => {
  const jobs = [
    makeJob({ slug: '01-fresh' }),
    makeJob({ slug: '02-unstamped-retry', autoFixAttempted: true, autoFixRetries: 0 }),
    makeJob({ slug: '03-unstamped-exhausted', autoFixAttempted: true, autoFixRetries: 1 }),
    makeJob({ slug: '04-error-retry', autoFixAttempted: true, autoFixOutcome: 'error', autoFixRetries: 0 }),
    makeJob({ slug: '05-error-exhausted', autoFixAttempted: true, autoFixOutcome: 'error', autoFixRetries: 1 }),
    makeJob({ slug: '06-plan-unqueued', autoFixAttempted: true, autoFixOutcome: 'plan', autoFixRetries: 0 }),
  ];
  const planJob = jobs.find((j) => j.slug === '06-plan-unqueued');
  const planQueuedJob = makeJob({
    slug: '07-plan-queued', parallelGroup: 7, autoFixAttempted: true, autoFixOutcome: 'plan', autoFixRetries: 0,
  });
  jobs.push(planQueuedJob);
  const queuedSlugs = new Set([fixSlugFor(planQueuedJob)]);

  const targets = new Set(selectAutoFixTargets(jobs, { fixSlugExists: noSiblingOnDisk }).map((j) => j.slug));
  for (const job of jobs) {
    const selected = targets.has(job.slug);
    const annotated = isAnnotatable(job, queuedSlugs);
    if (job.slug === '07-plan-queued') {
      // The good path: waiting on the fix-plan job itself, no action here.
      expect(selected).toBe(false);
      expect(annotated).toBe(false);
      continue;
    }
    expect(selected || annotated).toBe(true);
  }
  expect(isPlanUnqueued(planJob, queuedSlugs)).toBe(true);
});

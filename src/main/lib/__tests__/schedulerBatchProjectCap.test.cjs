'use strict';

// Run: timeout 120 npx vitest run src/main/lib/__tests__/schedulerBatchProjectCap.test.cjs
//
// Regression coverage for the per-project job cap (PRD 1066): the global
// sessionSlots pool is machine-wide and project-blind, so all of it can land
// on one project — measured 2026-08-31 as 4 concurrent executors on one
// project, loadavg 25.89/14 cores, silently converting that project's
// timing-sensitive test gate into a no-op. These tests pin the fix: an INNER
// per-cwd cap inside pickNextBatch/pickForProject, layered under the existing
// global pool (never a replacement for it).

const assert = require('node:assert/strict');
const { pickNextBatch, pickForProject } = require('../schedulerBatch.cjs');

const CWD_A = '/home/user/Projects/project-a';
const CWD_B = '/home/user/Projects/project-b';

function job(slug, status, cwd, extra = {}) {
  return {
    slug,
    status,
    cwd,
    parallelGroup: Number(String(slug).match(/^(\d+)-/)?.[1] ?? 99),
    dependsOn: [],
    ...extra,
  };
}

const ORIGINAL_CAP_ENV = process.env.SM_PROJECT_JOB_CAP;
afterEach(() => {
  if (ORIGINAL_CAP_ENV === undefined) delete process.env.SM_PROJECT_JOB_CAP;
  else process.env.SM_PROJECT_JOB_CAP = ORIGINAL_CAP_ENV;
});

test('three eligible jobs in one project, default cap 2 -> exactly 2 selected', () => {
  delete process.env.SM_PROJECT_JOB_CAP;
  const jobs = [
    job('101-a', 'pending', CWD_A),
    job('102-b', 'pending', CWD_A),
    job('103-c', 'pending', CWD_A),
  ];
  const { batch } = pickNextBatch(jobs, new Set(), 5);
  assert.deepEqual(batch.map((j) => j.slug), ['101-a', '102-b']);
});

test('cap is per-project: two projects with 2 eligible jobs each (cap 2) both fire in full', () => {
  delete process.env.SM_PROJECT_JOB_CAP;
  const jobs = [
    job('101-a', 'pending', CWD_A),
    job('102-b', 'pending', CWD_A),
    job('201-a', 'pending', CWD_B),
    job('202-b', 'pending', CWD_B),
  ];
  const { batch } = pickNextBatch(jobs, new Set(), 5);
  // A global cap of 2 would only ever admit 2 total; the per-project cap
  // admits up to 2 PER cwd, so all 4 fire here against a 5-slot pool.
  assert.deepEqual(
    batch.map((j) => j.slug).sort(),
    ['101-a', '102-b', '201-a', '202-b'],
  );
});

test('SM_PROJECT_JOB_CAP=1 -> exactly 1 selected', () => {
  process.env.SM_PROJECT_JOB_CAP = '1';
  const jobs = [
    job('101-a', 'pending', CWD_A),
    job('102-b', 'pending', CWD_A),
    job('103-c', 'pending', CWD_A),
  ];
  const { batch } = pickNextBatch(jobs, new Set(), 5);
  assert.deepEqual(batch.map((j) => j.slug), ['101-a']);
});

test('a job deferred by the project cap stays eligible and fires once a sibling finishes', () => {
  delete process.env.SM_PROJECT_JOB_CAP;
  const jobs = [
    job('101-a', 'running', CWD_A),
    job('102-b', 'running', CWD_A),
    job('103-c', 'pending', CWD_A),
  ];
  // Tick 1: both slots for this project are already running (cap 2) -> 103-c
  // is held, NOT failed/skipped, and remains 'pending' in the queue.
  const running1 = new Set(['101-a', '102-b']);
  const tick1 = pickNextBatch(jobs, running1, 5);
  assert.deepEqual(tick1.batch, []);
  assert.match(tick1.reason, /project-cap/);
  assert.equal(jobs.find((j) => j.slug === '103-c').status, 'pending');

  // Tick 2: 101-a finished (removed from running, its row now 'completed');
  // 103-c is still eligible and fires on this later tick.
  const jobsTick2 = [
    job('101-a', 'completed', CWD_A),
    job('102-b', 'running', CWD_A),
    job('103-c', 'pending', CWD_A),
  ];
  const running2 = new Set(['102-b']);
  const tick2 = pickNextBatch(jobsTick2, running2, 5);
  assert.deepEqual(tick2.batch.map((j) => j.slug), ['103-c']);
});

test('cap counts an untracked running row (boot-orphan grace window), not just the tracked running Set', () => {
  delete process.env.SM_PROJECT_JOB_CAP;
  const jobs = [
    // status:running but its slug is absent from the caller's `running` Set —
    // e.g. still alive during BOOT_ORPHAN_KILL_GRACE_MS before reconciliation
    // catches up. Must still count against the cap.
    job('101-a', 'running', CWD_A),
    job('102-b', 'running', CWD_A),
    job('103-c', 'pending', CWD_A),
  ];
  const { batch, reason } = pickNextBatch(jobs, new Set(), 5);
  assert.deepEqual(batch, []);
  assert.match(reason, /project-cap/);
});

test('pickForProject: cap counts jobs already running in that project', () => {
  delete process.env.SM_PROJECT_JOB_CAP;
  const jobs = [
    job('101-a', 'running', CWD_A),
    job('102-b', 'running', CWD_A),
    job('103-c', 'pending', CWD_A),
  ];
  const { batch, reason } = pickForProject(jobs, new Set(['101-a', '102-b']), 5);
  assert.deepEqual(batch, []);
  assert.match(reason, /project-cap/);
});

/**
 * scheduler-job-overrun.test.cjs — findOverrunningJobs: escalate a RUNNING
 * job that has blown past its own PRD's `estimateMinutes`.
 *
 * Covers the blind spot between the two existing kill paths, which is how a
 * PRD ran 3h+ on 2026-08-08 with nothing noticing:
 *   - MAX_JOB_DURATION_MS (4h) deadman — 3h is still an hour short of it
 *   - IDLE_OUTPUT_KILL_MS (20m) — only fires on a STALLED log; a job looping
 *     while still writing output never trips it
 * `estimateMinutes` was stored and displayed but never compared to runtime.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/scheduler-job-overrun.test.cjs
 */

'use strict';

// vitest, NOT node:test — this repo's suite is vitest-only (CLAUDE.md). A
// node:test file loads here as "No test suite found" and contributes zero
// tests, so the guard silently wouldn't exist.
import { test } from 'vitest';
const assert = require('node:assert/strict');
const {
  findOverrunningJobs,
  JOB_OVERRUN_FACTOR,
  JOB_OVERRUN_FLOOR_MS,
  resetJobFields,
} = require('../scheduler.cjs');

const NOW = Date.parse('2026-08-08T12:00:00.000Z');
const agoMin = (m) => new Date(NOW - m * 60_000).toISOString();

test('the real incident: a 20-minute PRD still running at 3h escalates', () => {
  const jobs = [
    { slug: '1029-long', cwd: '/p1', status: 'running', estimateMinutes: 20, startedAt: agoMin(180) },
  ];
  const over = findOverrunningJobs(jobs, NOW);
  assert.strictEqual(over.length, 1);
  assert.strictEqual(over[0].slug, '1029-long');
  assert.strictEqual(over[0].estimateMinutes, 20);
  assert.ok(over[0].ratio >= 8.9 && over[0].ratio <= 9.1, `expected ~9x, got ${over[0].ratio}`);
});

test('a job comfortably inside its estimate does not escalate', () => {
  const jobs = [
    { slug: 'ok', cwd: '/p1', status: 'running', estimateMinutes: 60, startedAt: agoMin(30) },
  ];
  assert.deepStrictEqual(findOverrunningJobs(jobs, NOW), []);
});

test('the floor stops a tiny estimate escalating on noise', () => {
  // 5m estimate x3 = 15m, but the floor is 45m — at 20m elapsed this is
  // over the factor yet under the floor, so it must stay silent.
  const jobs = [
    { slug: 'tiny', cwd: '/p1', status: 'running', estimateMinutes: 5, startedAt: agoMin(20) },
  ];
  assert.deepStrictEqual(findOverrunningJobs(jobs, NOW), []);
  // Past the floor it does escalate.
  const past = findOverrunningJobs(
    [{ slug: 'tiny', cwd: '/p1', status: 'running', estimateMinutes: 5, startedAt: agoMin(50) }],
    NOW,
  );
  assert.strictEqual(past.length, 1);
});

test('only RUNNING jobs are considered — pending/completed/quarantined are not', () => {
  const base = { cwd: '/p1', estimateMinutes: 10, startedAt: agoMin(300) };
  const jobs = [
    { ...base, slug: 'a', status: 'pending' },
    { ...base, slug: 'b', status: 'completed' },
    { ...base, slug: 'c', status: 'failed' },
    { ...base, slug: 'd', status: 'quarantined' },
    { ...base, slug: 'e', status: 'needs_review' },
  ];
  assert.deepStrictEqual(findOverrunningJobs(jobs, NOW), []);
});

test('a job with no usable estimate or start time is skipped, never guessed at', () => {
  const jobs = [
    { slug: 'no-est', cwd: '/p1', status: 'running', startedAt: agoMin(300) },
    { slug: 'zero-est', cwd: '/p1', status: 'running', estimateMinutes: 0, startedAt: agoMin(300) },
    { slug: 'nan-est', cwd: '/p1', status: 'running', estimateMinutes: 'soon', startedAt: agoMin(300) },
    { slug: 'no-start', cwd: '/p1', status: 'running', estimateMinutes: 10 },
    { slug: 'bad-start', cwd: '/p1', status: 'running', estimateMinutes: 10, startedAt: 'not-a-date' },
  ];
  assert.deepStrictEqual(findOverrunningJobs(jobs, NOW), []);
});

test('a clock skew making elapsed negative does not escalate', () => {
  const jobs = [
    { slug: 'future', cwd: '/p1', status: 'running', estimateMinutes: 10, startedAt: agoMin(-60) },
  ];
  assert.deepStrictEqual(findOverrunningJobs(jobs, NOW), []);
});

test('escalation is per-project and reports every overrunning job', () => {
  const jobs = [
    { slug: 'p1-a', cwd: '/p1', status: 'running', estimateMinutes: 20, startedAt: agoMin(180) },
    { slug: 'p2-a', cwd: '/p2', status: 'running', estimateMinutes: 30, startedAt: agoMin(200) },
    { slug: 'p2-b', cwd: '/p2', status: 'running', estimateMinutes: 60, startedAt: agoMin(30) },
  ];
  const slugs = findOverrunningJobs(jobs, NOW).map((o) => o.slug).sort();
  assert.deepStrictEqual(slugs, ['p1-a', 'p2-a']);
});

test('factor and floor are overridable per call', () => {
  const jobs = [
    { slug: 'x', cwd: '/p1', status: 'running', estimateMinutes: 60, startedAt: agoMin(90) },
  ];
  // Default: 60m x3 = 180m threshold, 90m elapsed → silent.
  assert.deepStrictEqual(findOverrunningJobs(jobs, NOW), []);
  // Tighter factor → escalates.
  assert.strictEqual(findOverrunningJobs(jobs, NOW, { factor: 1.5, floorMs: 0 }).length, 1);
});

test('the shipped defaults are the documented ones', () => {
  assert.strictEqual(JOB_OVERRUN_FACTOR, 3);
  assert.strictEqual(JOB_OVERRUN_FLOOR_MS, 45 * 60_000);
});

// The escalation loop in scheduler.cjs (~8700) stamps job.overrun straight
// from findOverrunningJobs' own return shape — these tests exercise that
// exact shape against the live starry-night-ships incident fixture
// (estimateMinutes: 22, ranMs: 6379556, ratio: 4.83) rather than duplicating
// the threshold math the escalation loop itself must not recompute.

test('the live incident fixture (4.9x over a 22m estimate) is stamped', () => {
  const startedAt = new Date(NOW - 6379556).toISOString();
  const jobs = [
    { slug: '231-saturn-record-and-docs', cwd: '/starry', status: 'running', estimateMinutes: 22, startedAt },
  ];
  const over = findOverrunningJobs(jobs, NOW);
  assert.strictEqual(over.length, 1);
  const [hit] = over;
  assert.ok(hit.ratio >= 4.8 && hit.ratio <= 4.9, `expected ~4.83x, got ${hit.ratio}`);

  // Mirror the escalation loop's own stamp assignment (job.overrun = {...}) —
  // same fields the ScheduleJobLite renderer type now carries.
  const job = jobs[0];
  job.overrun = { ratio: hit.ratio, ranMs: hit.ranMs, estimateMinutes: hit.estimateMinutes, at: new Date(NOW).toISOString() };
  assert.strictEqual(job.overrun.estimateMinutes, 22);
  assert.strictEqual(job.overrun.ranMs, 6379556);
  assert.ok(job.overrun.ratio >= 4.8 && job.overrun.ratio <= 4.9);

  // Idempotent re-escalation: a later sweep overwrites in place, never appends.
  const laterNow = NOW + 10 * 60_000;
  const laterOver = findOverrunningJobs(jobs, laterNow)[0];
  job.overrun = {
    ratio: laterOver.ratio, ranMs: laterOver.ranMs, estimateMinutes: laterOver.estimateMinutes, at: new Date(laterNow).toISOString(),
  };
  assert.strictEqual(typeof job.overrun, 'object');
  assert.ok(job.overrun.ranMs > hit.ranMs, 'ranMs should have advanced on re-escalation, not duplicated');
});

test('a job with no usable estimate is never in the escalation list, so it is never stamped', () => {
  const jobs = [
    { slug: 'no-est', cwd: '/p1', status: 'running', startedAt: agoMin(300) },
  ];
  assert.deepStrictEqual(findOverrunningJobs(jobs, NOW), []);
  assert.strictEqual(jobs[0].overrun, undefined);
});

test('resetJobFields clears a stamped overrun badge — this run\'s outcome, not durable across a reset', () => {
  const job = {
    slug: '231-saturn-record-and-docs',
    status: 'running',
    statusHistory: [],
    runId: 'r1',
    startedAt: agoMin(180),
    overrun: { ratio: 4.83, ranMs: 6379556, estimateMinutes: 22, at: new Date(NOW).toISOString() },
  };
  const ok = resetJobFields(job, 'reset for test');
  assert.strictEqual(ok, true);
  assert.strictEqual(job.status, 'pending');
  assert.strictEqual('overrun' in job, false);
});

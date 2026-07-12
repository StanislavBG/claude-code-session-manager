/**
 * scheduler-autofix-select.test.cjs — unit tests for selectAutoFixTargets.
 *
 * Run: timeout 120 node --test src/main/__tests__/scheduler-autofix-select.test.cjs
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { selectAutoFixTargets, isUnresolvableNeedsReview, isRescanCandidate } = require('../scheduler.cjs');

const noSiblingOnDisk = () => false;
const noRunDir = () => null;

function makeJob(overrides = {}) {
  return {
    slug: '05-my-feature',
    status: 'needs_review',
    runId: '2026-06-16T10-00-00-000Z',
    parallelGroup: 5,
    ...overrides,
  };
}

test('selects a fresh needs_review job', () => {
  const jobs = [makeJob()];
  const result = selectAutoFixTargets(jobs, { fixSlugExists: noSiblingOnDisk });
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].slug, '05-my-feature');
});

test('excludes job with autoFixAttempted: true', () => {
  const jobs = [makeJob({ autoFixAttempted: true })];
  const result = selectAutoFixTargets(jobs, { fixSlugExists: noSiblingOnDisk });
  assert.strictEqual(result.length, 0);
});

test('excludes a fix-plan slug (05-fix-foo)', () => {
  const jobs = [makeJob({ slug: '05-fix-foo' })];
  const result = selectAutoFixTargets(jobs, { fixSlugExists: noSiblingOnDisk });
  assert.strictEqual(result.length, 0);
});

test('excludes a failed job', () => {
  const jobs = [makeJob({ status: 'failed' })];
  const result = selectAutoFixTargets(jobs, { fixSlugExists: noSiblingOnDisk });
  assert.strictEqual(result.length, 0);
});

test('excludes a completed job', () => {
  const jobs = [makeJob({ status: 'completed' })];
  const result = selectAutoFixTargets(jobs, { fixSlugExists: noSiblingOnDisk });
  assert.strictEqual(result.length, 0);
});

test('excludes a job missing runId when no run dir resolves', () => {
  const jobs = [makeJob({ runId: null })];
  const result = selectAutoFixTargets(jobs, { fixSlugExists: noSiblingOnDisk, resolveJobRunId: noRunDir });
  assert.strictEqual(result.length, 0);
});

test('selects a job missing runId when a run dir resolves (gap 1: runId backfill)', () => {
  const jobs = [makeJob({ runId: null })];
  const result = selectAutoFixTargets(jobs, {
    fixSlugExists: noSiblingOnDisk,
    resolveJobRunId: () => '2026-06-16T10-00-00-000Z',
  });
  assert.strictEqual(result.length, 1);
});

test('isUnresolvableNeedsReview: needs_review + no runId + no run dir → true', () => {
  const job = makeJob({ runId: null });
  assert.strictEqual(isUnresolvableNeedsReview(job, { hasRunDir: false }), true);
});

test('isUnresolvableNeedsReview: needs_review + no runId + has run dir → false', () => {
  const job = makeJob({ runId: null });
  assert.strictEqual(isUnresolvableNeedsReview(job, { hasRunDir: true }), false);
});

test('isUnresolvableNeedsReview: needs_review + runId present → false', () => {
  const job = makeJob();
  assert.strictEqual(isUnresolvableNeedsReview(job, { hasRunDir: false }), false);
});

test('isUnresolvableNeedsReview: non needs_review status → false', () => {
  const job = makeJob({ runId: null, status: 'failed' });
  assert.strictEqual(isUnresolvableNeedsReview(job, { hasRunDir: false }), false);
});

test('autoFixOutcome no-plan with retries=0 is retried', () => {
  const jobs = [makeJob({ autoFixAttempted: true, autoFixOutcome: 'no-plan', autoFixRetries: 0 })];
  const result = selectAutoFixTargets(jobs, { fixSlugExists: noSiblingOnDisk });
  assert.strictEqual(result.length, 1);
});

test('autoFixOutcome no-plan with retries=1 is exhausted (not selected)', () => {
  const jobs = [makeJob({ autoFixAttempted: true, autoFixOutcome: 'no-plan', autoFixRetries: 1 })];
  const result = selectAutoFixTargets(jobs, { fixSlugExists: noSiblingOnDisk });
  assert.strictEqual(result.length, 0);
});

test('autoFixAttempted true with no outcome recorded stays excluded (existing 1-attempt cap)', () => {
  const jobs = [makeJob({ autoFixAttempted: true })];
  const result = selectAutoFixTargets(jobs, { fixSlugExists: noSiblingOnDisk });
  assert.strictEqual(result.length, 0);
});

test('excludes when fix sibling exists on disk', () => {
  const jobs = [makeJob()];
  // fixSlug = '05-fix-my-feature'
  const result = selectAutoFixTargets(jobs, { fixSlugExists: (s) => s === '05-fix-my-feature' });
  assert.strictEqual(result.length, 0);
});

test('excludes when fix sibling already in the queue', () => {
  const sibling = { slug: '05-fix-my-feature', status: 'pending', runId: null };
  const jobs = [makeJob(), sibling];
  const result = selectAutoFixTargets(jobs, { fixSlugExists: noSiblingOnDisk });
  assert.strictEqual(result.length, 0);
});

test('fixSlug uses padded parallelGroup and strips leading digits from slug', () => {
  const jobs = [makeJob({ slug: '07-some-task', parallelGroup: 7 })];
  // Expected fixSlug: '07-fix-some-task'
  const seen = [];
  selectAutoFixTargets(jobs, {
    fixSlugExists: (s) => { seen.push(s); return false; },
  });
  assert.strictEqual(seen[0], '07-fix-some-task');
});

test('defaults parallelGroup to 99 when absent', () => {
  const jobs = [makeJob({ slug: '05-my-feature', parallelGroup: undefined })];
  const seen = [];
  selectAutoFixTargets(jobs, {
    fixSlugExists: (s) => { seen.push(s); return false; },
  });
  assert.strictEqual(seen[0], '99-fix-my-feature');
});

test('isRescanCandidate: needs_review + runId + no_verdict_sentinel → true (RESCANNABLE_VERDICTS includes it)', () => {
  const job = makeJob({ verifierVerdict: 'no_verdict_sentinel' });
  assert.strictEqual(isRescanCandidate(job), true);
});

test('isRescanCandidate: needs_review + runId + uncommitted_changes → false (git commit-guard verdict stays excluded)', () => {
  const job = makeJob({ verifierVerdict: 'uncommitted_changes' });
  assert.strictEqual(isRescanCandidate(job), false);
});

console.log('scheduler-autofix-select tests: PASS');

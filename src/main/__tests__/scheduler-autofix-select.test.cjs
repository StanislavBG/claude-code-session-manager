/**
 * scheduler-autofix-select.test.cjs — unit tests for selectAutoFixTargets.
 *
 * Run: timeout 120 node --test src/main/__tests__/scheduler-autofix-select.test.cjs
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { selectAutoFixTargets } = require('../scheduler.cjs');

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

test('excludes a job missing runId', () => {
  const jobs = [makeJob({ runId: null })];
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

console.log('scheduler-autofix-select tests: PASS');

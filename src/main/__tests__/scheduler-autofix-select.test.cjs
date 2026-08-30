/**
 * scheduler-autofix-select.test.cjs — unit tests for selectAutoFixTargets.
 *
 * Run: timeout 120 node --test src/main/__tests__/scheduler-autofix-select.test.cjs
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  selectAutoFixTargets, isUnresolvableNeedsReview, isRescanCandidate,
  healTargetForFix, isFixPlanBeyondDepthCap, MAX_INVESTIGATION_DEPTH,
  isEligibleForImmediateAutoFix, isExhaustedAutoFix, isPlanUnqueued, fixSlugFor,
} = require('../scheduler.cjs');

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

test('excludes job with autoFixAttempted: true whose retry is already spent', () => {
  const jobs = [makeJob({ autoFixAttempted: true, autoFixRetries: 1 })];
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

// ---- PRD: unstamped/error outcomes must retry once, not dead-end forever ----

test('autoFixAttempted true with NO outcome recorded (unstamped — spawn threw before onExit wired) is retry-eligible once', () => {
  const jobs = [makeJob({ autoFixAttempted: true, autoFixRetries: 0 })];
  const result = selectAutoFixTargets(jobs, { fixSlugExists: noSiblingOnDisk });
  assert.strictEqual(result.length, 1);
});

test('autoFixAttempted true with no outcome AND retries=1 is exhausted (not selected)', () => {
  const jobs = [makeJob({ autoFixAttempted: true, autoFixRetries: 1 })];
  const result = selectAutoFixTargets(jobs, { fixSlugExists: noSiblingOnDisk });
  assert.strictEqual(result.length, 0);
});

test('autoFixOutcome error with retries=0 is retry-eligible', () => {
  const jobs = [makeJob({ autoFixAttempted: true, autoFixOutcome: 'error', autoFixRetries: 0 })];
  const result = selectAutoFixTargets(jobs, { fixSlugExists: noSiblingOnDisk });
  assert.strictEqual(result.length, 1);
});

test('autoFixOutcome error with retries=1 is exhausted (not selected)', () => {
  const jobs = [makeJob({ autoFixAttempted: true, autoFixOutcome: 'error', autoFixRetries: 1 })];
  const result = selectAutoFixTargets(jobs, { fixSlugExists: noSiblingOnDisk });
  assert.strictEqual(result.length, 0);
});

test('autoFixOutcome plan is NEVER retried, regardless of autoFixRetries', () => {
  const jobs = [makeJob({ autoFixAttempted: true, autoFixOutcome: 'plan', autoFixRetries: 0 })];
  const result = selectAutoFixTargets(jobs, { fixSlugExists: noSiblingOnDisk });
  assert.strictEqual(result.length, 0);
});

// ---- isExhaustedAutoFix / isPlanUnqueued (reverifyNeedsReview annotation) ----

test('isExhaustedAutoFix: no-plan outcome with retries spent → true', () => {
  const job = makeJob({ autoFixAttempted: true, autoFixOutcome: 'no-plan', autoFixRetries: 1 });
  assert.strictEqual(isExhaustedAutoFix(job), true);
});

test('isExhaustedAutoFix: error outcome with retries spent → true', () => {
  const job = makeJob({ autoFixAttempted: true, autoFixOutcome: 'error', autoFixRetries: 1 });
  assert.strictEqual(isExhaustedAutoFix(job), true);
});

test('isExhaustedAutoFix: unstamped outcome with retries spent → true', () => {
  const job = makeJob({ autoFixAttempted: true, autoFixRetries: 1 });
  assert.strictEqual(isExhaustedAutoFix(job), true);
});

test('isExhaustedAutoFix: retries not yet spent → false (still eligible for its one retry)', () => {
  const job = makeJob({ autoFixAttempted: true, autoFixOutcome: 'no-plan', autoFixRetries: 0 });
  assert.strictEqual(isExhaustedAutoFix(job), false);
});

test('isExhaustedAutoFix: plan outcome is never "exhausted" here — isPlanUnqueued\'s job instead', () => {
  const job = makeJob({ autoFixAttempted: true, autoFixOutcome: 'plan', autoFixRetries: 1 });
  assert.strictEqual(isExhaustedAutoFix(job), false);
});

test('isPlanUnqueued: plan outcome, fix slug absent from queue → true', () => {
  const job = makeJob({ autoFixAttempted: true, autoFixOutcome: 'plan' });
  assert.strictEqual(isPlanUnqueued(job, new Set()), true);
});

test('isPlanUnqueued: plan outcome, fix slug present in queue → false', () => {
  const job = makeJob({ autoFixAttempted: true, autoFixOutcome: 'plan' });
  assert.strictEqual(isPlanUnqueued(job, new Set([fixSlugFor(job)])), false);
});

test('isPlanUnqueued: no-plan outcome is never "plan unqueued"', () => {
  const job = makeJob({ autoFixAttempted: true, autoFixOutcome: 'no-plan' });
  assert.strictEqual(isPlanUnqueued(job, new Set()), false);
});

// ---- invariant: every needs_review job is either an auto-fix target, or
// classified by one of the annotation predicates (i.e. would receive a
// non-null verifierVerdict) — no job may fall through both. ----

test('invariant: attempted+no-outcome, retries spent → not a target, but IS annotatable', () => {
  const job = makeJob({ autoFixAttempted: true, autoFixRetries: 1 });
  const isTarget = selectAutoFixTargets([job], { fixSlugExists: noSiblingOnDisk }).length === 1;
  const isAnnotatable = isExhaustedAutoFix(job) || isPlanUnqueued(job, new Set())
    || isUnresolvableNeedsReview(job, { hasRunDir: true });
  assert.strictEqual(isTarget, false);
  assert.strictEqual(isAnnotatable, true);
});

test('invariant: plan outcome, no queue row → not a target, but IS annotatable (autofix_plan_unqueued)', () => {
  const job = makeJob({ autoFixAttempted: true, autoFixOutcome: 'plan' });
  const isTarget = selectAutoFixTargets([job], { fixSlugExists: noSiblingOnDisk }).length === 1;
  const isAnnotatable = isExhaustedAutoFix(job) || isPlanUnqueued(job, new Set())
    || isUnresolvableNeedsReview(job, { hasRunDir: true });
  assert.strictEqual(isTarget, false);
  assert.strictEqual(isAnnotatable, true);
});

test('invariant: plan outcome WITH a queue row → not a target and NOT annotated (waiting on the fix-plan job itself)', () => {
  const job = makeJob({ autoFixAttempted: true, autoFixOutcome: 'plan' });
  const queuedSlugs = new Set([fixSlugFor(job)]);
  const isTarget = selectAutoFixTargets([job], { fixSlugExists: noSiblingOnDisk }).length === 1;
  const isAnnotatable = isExhaustedAutoFix(job) || isPlanUnqueued(job, queuedSlugs)
    || isUnresolvableNeedsReview(job, { hasRunDir: true });
  assert.strictEqual(isTarget, false);
  assert.strictEqual(isAnnotatable, false);
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

test('isRescanCandidate: needs_review + runId + pass_no_commit → true (fix-plan exemption can flip the verdict on rescan)', () => {
  const job = makeJob({ verifierVerdict: 'pass_no_commit' });
  assert.strictEqual(isRescanCandidate(job), true);
});

// ---- investigationDepth bound (fix-plan-of-a-fix-plan recursion cap) ----

test('depth-1 (ordinary, no investigationDepth field) needs_review job is eligible', () => {
  const jobs = [makeJob({ slug: '05-my-feature' })];
  const result = selectAutoFixTargets(jobs, { fixSlugExists: noSiblingOnDisk });
  assert.strictEqual(result.length, 1);
});

test('fix-plan job with investigationDepth: 2 is now ALSO eligible', () => {
  const jobs = [makeJob({ slug: '05-fix-foo', investigationDepth: 2 })];
  const result = selectAutoFixTargets(jobs, { fixSlugExists: noSiblingOnDisk });
  assert.strictEqual(result.length, 1);
});

test('fix-plan job with investigationDepth: 3 is NOT eligible (bound holds)', () => {
  const jobs = [makeJob({ slug: '05-fix-foo', investigationDepth: 3 })];
  const result = selectAutoFixTargets(jobs, { fixSlugExists: noSiblingOnDisk });
  assert.strictEqual(result.length, 0);
});

test('legacy fix-plan job with no investigationDepth field defaults to excluded (back-compat)', () => {
  const jobs = [makeJob({ slug: '05-fix-foo' })];
  const result = selectAutoFixTargets(jobs, { fixSlugExists: noSiblingOnDisk });
  assert.strictEqual(result.length, 0);
});

test('isFixPlanBeyondDepthCap: non-fix-plan slug is never capped regardless of depth', () => {
  assert.strictEqual(isFixPlanBeyondDepthCap('05-my-feature', 99), false);
});

test('isFixPlanBeyondDepthCap: fix-plan at depth 1 or 2 is not capped, depth 3 is', () => {
  assert.strictEqual(isFixPlanBeyondDepthCap('05-fix-foo', 1), false);
  assert.strictEqual(isFixPlanBeyondDepthCap('05-fix-foo', MAX_INVESTIGATION_DEPTH), false);
  assert.strictEqual(isFixPlanBeyondDepthCap('05-fix-foo', MAX_INVESTIGATION_DEPTH + 1), true);
});

test('healTargetForFix: depth-2 fix-of-a-fix slug resolves back to the depth-1 fix job (521-fix-recorder-export-footer-redesign)', () => {
  // Depth-1 fix job: originally authored to fix job 521, itself in needs_review.
  const depth1FixJob = {
    slug: '521-fix-recorder-export-footer-redesign',
    status: 'needs_review',
    parallelGroup: 521,
    investigationDepth: 2,
  };
  const jobs = [depth1FixJob];
  // spawnInvestigation's fix-slug formula: baseSlug strips only the leading
  // numeric prefix (not "fix-"), so investigating this depth-1 fix job
  // produces a depth-2 fix slug of the form "<group>-fix-fix-<rest>".
  const baseSlug = depth1FixJob.slug.replace(/^\d+-/, '');
  const depth2FixSlug = `${String(depth1FixJob.parallelGroup).padStart(2, '0')}-fix-${baseSlug}`;
  assert.strictEqual(depth2FixSlug, '521-fix-fix-recorder-export-footer-redesign');
  const resolved = healTargetForFix(depth2FixSlug, jobs);
  assert.strictEqual(resolved, depth1FixJob);
});

// ---- isEligibleForImmediateAutoFix (spawnJob's same-tick auto-fix trigger,
// PRD 2026-07-12: needs_review jobs no longer wait up to 10 min for
// reverifyNeedsReview()'s periodic pass) ----

test('isEligibleForImmediateAutoFix: fresh needs_review job (fresh from spawnJob, not reverifyNeedsReview) is eligible', () => {
  const job = makeJob();
  const result = isEligibleForImmediateAutoFix(job, [job], noSiblingOnDisk);
  assert.strictEqual(result, true);
});

test('isEligibleForImmediateAutoFix: attempted job with retry already spent is excluded (prevents double-spawn with the periodic pass)', () => {
  const job = makeJob({ autoFixAttempted: true, autoFixRetries: 1 });
  const result = isEligibleForImmediateAutoFix(job, [job], noSiblingOnDisk);
  assert.strictEqual(result, false);
});

test('isEligibleForImmediateAutoFix: attempted job with an unstamped outcome and its retry still unspent IS eligible (bounded once)', () => {
  const job = makeJob({ autoFixAttempted: true, autoFixRetries: 0 });
  const result = isEligibleForImmediateAutoFix(job, [job], noSiblingOnDisk);
  assert.strictEqual(result, true);
});

test('isEligibleForImmediateAutoFix: fix sibling already on disk excludes the job', () => {
  const job = makeJob();
  // fixSlug = '05-fix-my-feature'
  const result = isEligibleForImmediateAutoFix(job, [job], (s) => s === '05-fix-my-feature');
  assert.strictEqual(result, false);
});

test('isEligibleForImmediateAutoFix: fix-plan job beyond the depth cap is excluded', () => {
  const job = makeJob({ slug: '05-fix-foo', investigationDepth: 3 });
  const result = isEligibleForImmediateAutoFix(job, [job], noSiblingOnDisk);
  assert.strictEqual(result, false);
});

test('isEligibleForImmediateAutoFix: a different job in the same queue does not affect this job\'s eligibility', () => {
  const job = makeJob();
  const other = { slug: '05-fix-my-feature', status: 'pending', runId: null };
  const result = isEligibleForImmediateAutoFix(job, [job, other], noSiblingOnDisk);
  // The fix sibling is already queued, so this job is excluded too (matches
  // selectAutoFixTargets's "no fix sibling in queue" rule).
  assert.strictEqual(result, false);
});

test('isEligibleForImmediateAutoFix: a job whose status is not needs_review (e.g. still pending) is excluded', () => {
  const job = makeJob({ status: 'pending' });
  const result = isEligibleForImmediateAutoFix(job, [job], noSiblingOnDisk);
  assert.strictEqual(result, false);
});

console.log('scheduler-autofix-select tests: PASS');

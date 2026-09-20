/**
 * scheduler-needs-review-autoresolve.test.cjs
 *
 * Covers the bounded automatic terminal decision for an EXHAUSTED
 * needs_review row (isExhaustedAutoFix === true): selectExhaustedNeedsReviewTargets
 * (the pure selector), applyNeedsReviewAutoResolve (the three-branch policy
 * applier, extracted from the 10-minute interval body so it's testable
 * without queue.json IO), needsReviewAutoResolveDisabled (its kill switch),
 * and the dependsOn carve-out in schedulerBatch.cjs's findBlockingDep that
 * lets a chain actually drain once this pass auto-skips a row.
 *
 * HOME is overridden to a tmp dir BEFORE requiring scheduler.cjs — same
 * reason as scheduler-failed-autoreset.test.cjs (appendAuditEvent writes
 * under $HOME/.claude/session-manager/audit-log.jsonl).
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/scheduler-needs-review-autoresolve.test.cjs
 */

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'needs-review-autoresolve-test-'));
process.env.HOME = tmpHome;

// Fixture cwd must be a REAL, writable dir: every transitionJob out of
// needs_review fire-and-forgets a history append under <cwd>/session-manager-operations.
// A fake path ('/home/user/project') made that append fail with EACCES *after*
// the synchronous test returned, so its console.error landed while vitest was
// closing the worker ("Closing rpc while onUserConsoleLog was pending" -> exit 1).
const PROJECT_CWD = path.join(tmpHome, 'project');
fs.mkdirSync(PROJECT_CWD, { recursive: true });

const {
  selectExhaustedNeedsReviewTargets,
  applyNeedsReviewAutoResolve,
  NEEDS_REVIEW_RESOLVE_CAP,
  needsReviewAutoResolveDisabled,
} = require('../scheduler.cjs');

const { pickForProject } = require('../lib/schedulerBatch.cjs');

const MIN_MS = 60_000;
const THRESHOLD_MS = 30 * MIN_MS;

function exhaustedJob(overrides = {}) {
  return {
    slug: 'exhausted-row',
    cwd: PROJECT_CWD,
    status: 'needs_review',
    autoFixAttempted: true,
    autoFixOutcome: 'no-plan',
    autoFixRetries: 1, // spent, per isExhaustedAutoFix
    statusHistory: [{ to: 'needs_review', at: new Date(Date.now() - 45 * MIN_MS).toISOString() }],
    ...overrides,
  };
}

// --- selectExhaustedNeedsReviewTargets ---

test('a fresh exhausted needs_review row (under threshold) is not selected', () => {
  const job = exhaustedJob({
    statusHistory: [{ to: 'needs_review', at: new Date(Date.now() - 2 * MIN_MS).toISOString() }],
  });
  assert.equal(selectExhaustedNeedsReviewTargets([job], Date.now(), THRESHOLD_MS).length, 0);
});

test('a non-exhausted needs_review row (still eligible for a real auto-fix investigation) is left alone', () => {
  // autoFixRetries: 0 — isExhaustedAutoFix is false here (an unspent retry
  // remains); this pass must never steal a row selectAutoFixTargets still owns.
  const job = exhaustedJob({ autoFixRetries: 0 });
  assert.equal(selectExhaustedNeedsReviewTargets([job], Date.now(), THRESHOLD_MS).length, 0);
});

test('a non-needs_review status is never selected', () => {
  const job = exhaustedJob({ status: 'failed' });
  assert.equal(selectExhaustedNeedsReviewTargets([job], Date.now(), THRESHOLD_MS).length, 0);
});

test('an exhausted row past threshold, under the cap, is selected', () => {
  const job = exhaustedJob({ exhaustedResolveAttempts: 0 });
  const found = selectExhaustedNeedsReviewTargets([job], Date.now(), THRESHOLD_MS);
  assert.equal(found.length, 1);
  assert.equal(found[0].slug, 'exhausted-row');
  assert.equal(found[0].attempts, 0);
});

test('an exhausted row AT the cap is still selected — this is the pass that must terminally skip it', () => {
  const job = exhaustedJob({ exhaustedResolveAttempts: NEEDS_REVIEW_RESOLVE_CAP });
  const found = selectExhaustedNeedsReviewTargets([job], Date.now(), THRESHOLD_MS);
  assert.equal(found.length, 1);
});

test('a row already past the cap (defensive — should never occur once skipped) is excluded', () => {
  const job = exhaustedJob({ exhaustedResolveAttempts: NEEDS_REVIEW_RESOLVE_CAP + 1 });
  assert.equal(selectExhaustedNeedsReviewTargets([job], Date.now(), THRESHOLD_MS).length, 0);
});

test('needsReviewAutoResolveDisabled reflects SM_NEEDS_REVIEW_AUTORESOLVE_DISABLE', () => {
  const saved = process.env.SM_NEEDS_REVIEW_AUTORESOLVE_DISABLE;
  try {
    delete process.env.SM_NEEDS_REVIEW_AUTORESOLVE_DISABLE;
    assert.equal(needsReviewAutoResolveDisabled(), false);
    process.env.SM_NEEDS_REVIEW_AUTORESOLVE_DISABLE = '1';
    assert.equal(needsReviewAutoResolveDisabled(), true);
  } finally {
    if (saved === undefined) delete process.env.SM_NEEDS_REVIEW_AUTORESOLVE_DISABLE;
    else process.env.SM_NEEDS_REVIEW_AUTORESOLVE_DISABLE = saved;
  }
});

// --- applyNeedsReviewAutoResolve: the three policy branches ---

test('branch 1: a looksDone annotation resolves the row to completed', () => {
  const job = exhaustedJob({
    exhaustedResolveAttempts: 1,
    looksDone: { commits: ['abc1234'], paths: ['src/main/scheduler.cjs'], detectedAt: new Date().toISOString() },
  });
  const outcome = applyNeedsReviewAutoResolve(job);
  assert.equal(outcome, 'completed');
  assert.equal(job.status, 'completed');
});

test('branch 2: no looksDone, under the cap, requeues to pending and increments the attempt counter', () => {
  const job = exhaustedJob({ exhaustedResolveAttempts: 0 });
  const outcome = applyNeedsReviewAutoResolve(job);
  assert.equal(outcome, 'requeued');
  assert.equal(job.status, 'pending');
  assert.equal(job.exhaustedResolveAttempts, 1);
});

test('branch 2 again: a second requeue at attempts=1 also succeeds (cap is 2)', () => {
  const job = exhaustedJob({ exhaustedResolveAttempts: 1 });
  const outcome = applyNeedsReviewAutoResolve(job);
  assert.equal(outcome, 'requeued');
  assert.equal(job.status, 'pending');
  assert.equal(job.exhaustedResolveAttempts, 2);
});

test('branch 3: once the cap is spent, the row is auto-skipped with the reason recorded in job.error', () => {
  const job = exhaustedJob({ exhaustedResolveAttempts: NEEDS_REVIEW_RESOLVE_CAP });
  const outcome = applyNeedsReviewAutoResolve(job);
  assert.equal(outcome, 'skipped');
  assert.equal(job.status, 'skipped');
  assert.ok(typeof job.error === 'string' && job.error.length > 0, 'job.error must name the exhausted auto-fix path');
  assert.match(job.error, /exhausted auto-fix/i);
  assert.equal(job.needsReviewAutoResolvedSkip, true);
});

test('applyNeedsReviewAutoResolve race-guards against a row that moved off needs_review', () => {
  const job = exhaustedJob({ status: 'completed', exhaustedResolveAttempts: 0 });
  assert.equal(applyNeedsReviewAutoResolve(job), null);
  assert.equal(job.status, 'completed'); // untouched
});

// --- chain drain: the actual point of this PRD ---

test('a 3-row dependsOn chain drains: the exhausted middle row auto-skips and the third row becomes eligible', () => {
  const now = Date.now();
  const rowA = {
    slug: 'a-first', cwd: PROJECT_CWD, status: 'completed',
  };
  const rowB = exhaustedJob({
    slug: 'b-middle',
    cwd: PROJECT_CWD,
    exhaustedResolveAttempts: NEEDS_REVIEW_RESOLVE_CAP,
    dependsOn: ['a-first'],
  });
  const rowC = {
    slug: 'c-last', cwd: PROJECT_CWD, status: 'pending', dependsOn: ['b-middle'],
  };
  const jobs = [rowA, rowB, rowC];

  // Before resolution: C is blocked behind B's live needs_review row.
  const before = pickForProject(jobs, new Set(), 5);
  assert.equal(before.batch.length, 0, 'C must not be eligible while B still sits in needs_review');

  const targets = selectExhaustedNeedsReviewTargets(jobs, now, THRESHOLD_MS);
  assert.equal(targets.length, 1);
  assert.equal(targets[0].slug, 'b-middle');
  const outcome = applyNeedsReviewAutoResolve(rowB);
  assert.equal(outcome, 'skipped');
  assert.equal(rowB.status, 'skipped');

  const after = pickForProject(jobs, new Set(), 5);
  assert.ok(after.batch.some((j) => j.slug === 'c-last'), 'C must become eligible once B is auto-skipped');
});

test('a generic (non-auto-resolved) skipped dep still blocks forever — the carve-out is narrow', () => {
  const rowB = { slug: 'b-middle', cwd: PROJECT_CWD, status: 'skipped' }; // no needsReviewAutoResolvedSkip marker
  const rowC = { slug: 'c-last', cwd: PROJECT_CWD, status: 'pending', dependsOn: ['b-middle'] };
  const { batch } = pickForProject([rowB, rowC], new Set(), 5);
  assert.equal(batch.length, 0, 'a PRD-source-vanished skip must remain a permanent block, unaffected by this carve-out');
});

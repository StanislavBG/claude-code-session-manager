/**
 * needsHumanVerdict.test.cjs — SCHEDULER_VERDICT: NEEDS_HUMAN parsing and
 * its exclusion from every automatic review-ladder rung.
 */
import { test } from 'vitest';
const assert = require('node:assert/strict');
const { scanSentinel, scanHumanQuestion } = require('../runVerify.cjs');
const ladder = require('../scheduler/reviewLadder.cjs');

const res = (text) => ({ resultText: text });

test('scanSentinel maps a legacy NEEDS_HUMAN line to fail', () => {
  assert.equal(scanSentinel(res('done\nSCHEDULER_VERDICT: NEEDS_HUMAN Is promo X ok?'), []), 'fail');
  assert.equal(scanSentinel(res('SCHEDULER_VERDICT: NEEDS_HUMAN'), []), 'fail');
  assert.equal(scanSentinel(res('SCHEDULER_VERDICT: PASS'), []), 'pass');
});

test('scanHumanQuestion is deleted', () => {
  assert.equal(scanHumanQuestion, undefined);
});

const row = (over = {}) => ({
  slug: 'a', status: 'needs_review', runId: 'r1', sessionId: 's1', cwd: '/tmp/x',
  verifierVerdict: 'needs_human', humanQuestion: 'ok?',
  statusHistory: [{ to: 'needs_review', at: new Date(0).toISOString() }],
  ...over,
});

test('isNeedsHuman is gone', () => {
  assert.equal(ladder.isNeedsHuman, undefined);
});

test('selectMechanicalRecoveryTarget no longer exempts needs_human', () => {
  assert.equal(ladder.selectMechanicalRecoveryTarget(row()), null); // not a mechanical verdict
});

test('selectAutoFixTargets and isEligibleForImmediateAutoFix include needs_human', () => {
  const jobs = [row()];
  const opts = { fixSlugExists: () => false, resolveJobRunId: () => 'r1' };
  assert.equal(ladder.selectAutoFixTargets(jobs, opts).length, 1);
  assert.equal(ladder.isEligibleForImmediateAutoFix(jobs[0], jobs, () => false), true);
});

test('selectExhaustedNeedsReviewTargets includes a dwelt needs_human row', () => {
  const now = Date.now();
  assert.equal(ladder.selectExhaustedNeedsReviewTargets([row({ autoFixAttempted: true, autoFixOutcome: 'error', autoFixRetries: 1 })], now, 1000).length, 1);
});

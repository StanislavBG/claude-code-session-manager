/**
 * needsHumanVerdict.test.cjs — SCHEDULER_VERDICT: NEEDS_HUMAN parsing and
 * its exclusion from every automatic review-ladder rung.
 */
import { test } from 'vitest';
const assert = require('node:assert/strict');
const { scanSentinel, scanHumanQuestion } = require('../runVerify.cjs');
const ladder = require('../scheduler/reviewLadder.cjs');

const res = (text) => ({ resultText: text });

test('scanSentinel recognizes NEEDS_HUMAN with and without a question', () => {
  assert.equal(scanSentinel(res('done\nSCHEDULER_VERDICT: NEEDS_HUMAN Is promo X ok?'), []), 'needs_human');
  assert.equal(scanSentinel(res('SCHEDULER_VERDICT: NEEDS_HUMAN'), []), 'needs_human');
  assert.equal(scanSentinel(res('SCHEDULER_VERDICT: PASS'), []), 'pass');
});

test('scanHumanQuestion trims, caps at 300 chars, and is empty when absent', () => {
  assert.equal(scanHumanQuestion(res('SCHEDULER_VERDICT: NEEDS_HUMAN   Install cron?  '), []), 'Install cron?');
  assert.equal(scanHumanQuestion(res('SCHEDULER_VERDICT: NEEDS_HUMAN'), []), '');
  assert.equal(scanHumanQuestion(res('SCHEDULER_VERDICT: NEEDS_HUMAN ' + 'x'.repeat(500)), []).length, 300);
  assert.equal(scanHumanQuestion(res('SCHEDULER_VERDICT: PASS'), []), '');
  const ev = [{ kind: 'tool_result', content: 'SCHEDULER_VERDICT: NEEDS_HUMAN From tool?' }];
  assert.equal(scanHumanQuestion(null, ev), 'From tool?');
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

'use strict';
// Run: timeout 120 npx vitest run src/main/lib/scheduler/__tests__/planReviewStats.test.cjs
const assert = require('node:assert/strict');
const { planReviewStats } = require('../planReviewStats.cjs');

const reviewedRec = {
  validateSlug: 'v-a',
  reviews: [{ review: { prds: [{ prd: '10-alpha', decision: 'ok', findings: [] }] } }],
  release: { by: 'planner', accepted: 3, rejected: [{ finding: 'x', reason: 'y' }] },
};

test('empty input', () => {
  assert.deepEqual(planReviewStats(), {
    reviewed: { plans: 0, acceptedFindings: 0, rejectedFindings: 0, validatorFindings: 0, refuted: 0, escapes: 0 },
    unreviewed: { plans: 0, validatorFindings: 0, refuted: 0, escapes: 0 },
  });
  assert.equal(planReviewStats({ planReviews: [], verdictFiles: [], fixes: [] }).reviewed.plans, 0);
});

test('a reviewed and an unreviewed plan', () => {
  const out = planReviewStats({
    planReviews: [reviewedRec],
    verdictFiles: [
      { prd: 'alpha', verdict: 'REFUTED', findings: [{}, {}] },
      { prd: 'beta', verdict: 'REFUTED', findings: [{}], plan: 'v-b' },
      { prd: 'gamma', verdict: 'VERIFIED', findings: [], plan: 'v-b' },
    ],
  });
  assert.deepEqual(out.reviewed, { plans: 1, acceptedFindings: 3, rejectedFindings: 1, validatorFindings: 2, refuted: 1, escapes: 0 });
  assert.deepEqual(out.unreviewed, { plans: 1, validatorFindings: 1, refuted: 1, escapes: 0 });
});

test('escape counting by plan and missKind', () => {
  const out = planReviewStats({
    planReviews: [reviewedRec],
    fixes: [
      { prd: '10-alpha', missKind: 'spec-gap' },
      { prd: 'alpha', missKind: 'missing-test' },
      { prd: 'alpha', missKind: 'other' },
      { prd: '20-beta', missKind: 'spec-gap' },
    ],
  });
  assert.equal(out.reviewed.escapes, 2);
  assert.equal(out.unreviewed.escapes, 1);
});

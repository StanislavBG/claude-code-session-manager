'use strict';

const assert = require('node:assert/strict');
const { PLAN_REVIEW_SCHEMA, PLAN_REVIEW_CHECKS, parsePlanReview, isAllOk } = require('../planReviewSchema.cjs');

const finding = (over = {}) => ({ severity: 'Important', check: 'edge-case', text: 'x', ...over });
const okPrd = (prd) => ({ prd, decision: 'ok', findings: [] });
const review = (over = {}) => ({ prds: [okPrd('a'), okPrd('b')], planFindings: [], ...over });
const expected = ['a', 'b'];

describe('planReviewSchema', () => {
  it('exports the 8 checks and a schema', () => {
    assert.equal(PLAN_REVIEW_CHECKS.length, 8);
    assert.deepEqual(PLAN_REVIEW_SCHEMA.required, ['prds', 'planFindings']);
  });

  it('accepts a valid review', () => {
    const r = parsePlanReview(
      review({ prds: [okPrd('a'), { prd: 'b', decision: 'amend', findings: [finding({ suggestedEdit: 'e', field: 'f' })] }] }),
      { expected },
    );
    assert.equal(r.ok, true);
  });

  it('refuses a missing slug', () => {
    const r = parsePlanReview(review({ prds: [okPrd('a')] }), { expected });
    assert.equal(r.ok, false);
    assert.match(r.error, /missing b/);
  });

  it('refuses an extra slug', () => {
    const r = parsePlanReview(review({ prds: [okPrd('a'), okPrd('b'), okPrd('c')] }), { expected });
    assert.equal(r.ok, false);
    assert.match(r.error, /unexpected c/);
  });

  it('refuses an unknown decision', () => {
    const r = parsePlanReview(review({ prds: [{ prd: 'a', decision: 'maybe', findings: [] }, okPrd('b')] }), { expected });
    assert.equal(r.ok, false);
    assert.match(r.error, /decision/);
  });

  it('refuses an unknown check', () => {
    const r = parsePlanReview(
      review({ prds: [{ prd: 'a', decision: 'amend', findings: [finding({ check: 'nope' })] }, okPrd('b')] }),
      { expected },
    );
    assert.equal(r.ok, false);
    assert.match(r.error, /check/);
  });

  it('refuses an unknown severity', () => {
    const r = parsePlanReview(review({ planFindings: [finding({ severity: 'Huge' })] }), { expected });
    assert.equal(r.ok, false);
    assert.match(r.error, /severity/);
  });

  it('refuses amend and block with zero findings', () => {
    for (const decision of ['amend', 'block']) {
      const r = parsePlanReview(review({ prds: [{ prd: 'a', decision, findings: [] }, okPrd('b')] }), { expected });
      assert.equal(r.ok, false);
      assert.match(r.error, /needs at least one finding/);
    }
  });

  it('refuses unknown top-level keys', () => {
    const r = parsePlanReview({ ...review(), extra: 1 }, { expected });
    assert.equal(r.ok, false);
    assert.match(r.error, /unexpected key extra/);
  });

  it('refuses a non-object', () => {
    assert.equal(parsePlanReview(null).ok, false);
  });

  it('isAllOk true only when all ok and no planFindings', () => {
    assert.equal(isAllOk(review()), true);
    assert.equal(isAllOk(review({ planFindings: [finding()] })), false);
    assert.equal(isAllOk(review({ prds: [okPrd('a'), { prd: 'b', decision: 'block', findings: [finding()] }] })), false);
  });
});

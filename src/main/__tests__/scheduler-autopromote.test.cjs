/**
 * scheduler-autopromote.test.cjs — unit tests for isPromotableOriginal.
 *
 * Run: timeout 300 npx vitest run src/main/__tests__/scheduler-autopromote.test.cjs
 */

'use strict';

import { test } from 'vitest';
const assert = require('node:assert/strict');
const { isPromotableOriginal, healTargetForFix, applyFixSuccessToOriginal } = require('../scheduler.cjs');

test('isPromotableOriginal: failed → true', () => {
  assert.strictEqual(isPromotableOriginal('failed'), true);
});

test('isPromotableOriginal: needs_review → true', () => {
  assert.strictEqual(isPromotableOriginal('needs_review'), true);
});

test('isPromotableOriginal: completed → false', () => {
  assert.strictEqual(isPromotableOriginal('completed'), false);
});

test('isPromotableOriginal: running → false', () => {
  assert.strictEqual(isPromotableOriginal('running'), false);
});

test('isPromotableOriginal: pending → false', () => {
  assert.strictEqual(isPromotableOriginal('pending'), false);
});

test('healTargetForFix: matches the specific original by full numeric-prefixed slug, not just base', () => {
  const jobs = [
    { slug: '451-foo', status: 'needs_review' },
    { slug: '453-foo', status: 'needs_review' },
  ];
  const target = healTargetForFix('451-fix-foo', jobs);
  assert.strictEqual(target.slug, '451-foo');
});

test('healTargetForFix: returns null when no promotable original matches', () => {
  const jobs = [
    { slug: '451-foo', status: 'completed' },
    { slug: '453-foo', status: 'needs_review' },
  ];
  const target = healTargetForFix('451-fix-foo', jobs);
  assert.strictEqual(target, null);
});

const SOURCES = ['spawnJob:auto-promote', 'reverifyNeedsReview:auto-promote'];
for (const source of SOURCES) {
  test(`applyFixSuccessToOriginal (${source}): artifact-only parent is re-queued to pending, not completed`, () => {
    const orig = { slug: '451-foo', status: 'needs_review', deliverable: 'artifact', completedBy: 'x', looksDone: true, verifierVerdict: 'v' };
    const out = applyFixSuccessToOriginal(orig, '451-fix-foo', {
      promoteReason: 'auto-promoted', promoteSource: source, requeueSource: source,
    });
    assert.strictEqual(out, 'requeued');
    assert.strictEqual(orig.status, 'pending');
    assert.strictEqual(orig.completedBy, undefined);
    assert.strictEqual(orig.error, null);
    assert.strictEqual(orig.requeuedByFix, '451-fix-foo');
    const last = (orig.transitions || orig.statusHistory || []).slice(-1)[0];
    if (last && last.reason) assert.strictEqual(last.reason, 'requeued: fix plan 451-fix-foo succeeded');
  });

  test(`applyFixSuccessToOriginal (${source}): non-artifact parent is still completed`, () => {
    const orig = { slug: '451-foo', status: 'failed', deliverable: null };
    const out = applyFixSuccessToOriginal(orig, '451-fix-foo', {
      promoteReason: 'auto-promoted', promoteSource: source, requeueSource: source,
    });
    assert.strictEqual(out, 'completed');
    assert.strictEqual(orig.status, 'completed');
    assert.strictEqual(orig.completedBy, '451-fix-foo');
    assert.strictEqual(orig.exitCode, 0);
  });
}

test('applyFixSuccessToOriginal: an artifact parent already re-queued for this fix is not re-queued again', () => {
  const orig = { slug: '451-foo', status: 'failed', deliverable: 'artifact', requeuedByFix: '451-fix-foo' };
  const out = applyFixSuccessToOriginal(orig, '451-fix-foo', {
    promoteReason: 'r', promoteSource: SOURCES[1], requeueSource: SOURCES[1],
  });
  assert.strictEqual(out, 'skipped');
  assert.strictEqual(orig.status, 'failed');
});

console.log('scheduler-autopromote tests: PASS');

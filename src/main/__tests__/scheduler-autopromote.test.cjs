/**
 * scheduler-autopromote.test.cjs — unit tests for isPromotableOriginal.
 *
 * Run: timeout 120 node --test src/main/__tests__/scheduler-autopromote.test.cjs
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isPromotableOriginal, healTargetForFix } = require('../scheduler.cjs');

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

console.log('scheduler-autopromote tests: PASS');

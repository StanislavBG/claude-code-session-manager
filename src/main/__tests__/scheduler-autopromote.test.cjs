/**
 * scheduler-autopromote.test.cjs — unit tests for isPromotableOriginal.
 *
 * Run: timeout 120 node --test src/main/__tests__/scheduler-autopromote.test.cjs
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isPromotableOriginal } = require('../scheduler.cjs');

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

console.log('scheduler-autopromote tests: PASS');

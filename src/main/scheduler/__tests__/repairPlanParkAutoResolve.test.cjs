/**
 * repairPlanParkAutoResolve.test.cjs — a fix-plan PRD that parks needs_review
 * is excluded from auto-fix (no recursion), so autoFixAttempted is never set.
 * Rung 6 must still admit it, or its dependsOn chain waits forever (live case:
 * starry-night-2 852-fix-ios-asc-profile, 2026-11-22).
 *
 * Run: timeout 120 npx vitest run src/main/scheduler/__tests__/repairPlanParkAutoResolve.test.cjs
 */
'use strict';

import { test } from 'vitest';
const assert = require('node:assert/strict');
const ladder = require('../reviewLadder.cjs');

const PARKED_AT = '2026-11-22T20:44:00.000Z'; // 12:44 PM PST
const THRESHOLD = 30 * 60 * 1000;

const fixPlanRow = (extra = {}) => ({
  slug: '852-fix-ios-asc-profile',
  cwd: '/proj/starry-night-2',
  status: 'needs_review',
  isFixPlan: true,
  verifierVerdict: 'sentinel_fail',
  runId: 'run-852',
  statusHistory: [
    { from: 'pending', to: 'running', at: '2026-11-22T20:30:00.000Z' },
    { from: 'running', to: 'needs_review', at: PARKED_AT },
  ],
  ...extra,
});

test('isFixPlanParkWithoutAutoFix: real 852 row shape is a fix-plan park', () => {
  assert.equal(typeof ladder.isFixPlanParkWithoutAutoFix, 'function');
  assert.equal(ladder.isFixPlanParkWithoutAutoFix(fixPlanRow()), true);
  assert.equal(ladder.isFixPlanParkWithoutAutoFix(fixPlanRow({ status: 'pending' })), false);
  assert.equal(ladder.isFixPlanParkWithoutAutoFix(fixPlanRow({ autoFixAttempted: true })), false);
  // Slug fallback when the isFixPlan stamp is absent; explicit false wins.
  assert.equal(ladder.isFixPlanParkWithoutAutoFix(fixPlanRow({ isFixPlan: undefined })), true);
  assert.equal(ladder.isFixPlanParkWithoutAutoFix(fixPlanRow({ isFixPlan: false })), false);
});

test('fix-plan park is eligible for needs_review auto-resolve', () => {
  const row = fixPlanRow();
  assert.equal(ladder.isEligibleForNeedsReviewAutoResolve(row, [row]), true);
});

test('fix-plan park is selected once it has sat needs_review past the threshold', () => {
  const row = fixPlanRow();
  const now = Date.parse(PARKED_AT) + THRESHOLD + 1000;
  const targets = ladder.selectExhaustedNeedsReviewTargets([row], now, THRESHOLD);
  assert.equal(targets.length, 1);
  assert.equal(targets[0].slug, '852-fix-ios-asc-profile');
  assert.equal(targets[0].attempts, 0);
});

test('fix-plan park is not selected before the threshold', () => {
  const row = fixPlanRow();
  const now = Date.parse(PARKED_AT) + THRESHOLD - 1000;
  assert.deepEqual(ladder.selectExhaustedNeedsReviewTargets([row], now, THRESHOLD), []);
});

test('refire-capped fix-plan park is not eligible', () => {
  const row = fixPlanRow({ verifierVerdict: 'refire_capped' });
  assert.equal(ladder.isEligibleForNeedsReviewAutoResolve(row, [row]), false);
  const now = Date.parse(PARKED_AT) + THRESHOLD * 10;
  assert.deepEqual(ladder.selectExhaustedNeedsReviewTargets([row], now, THRESHOLD), []);
});

test('a non-fix-plan row without autoFixAttempted stays ineligible', () => {
  const row = fixPlanRow({ slug: '852-ios-asc-profile', isFixPlan: false });
  assert.equal(ladder.isEligibleForNeedsReviewAutoResolve(row, [row]), false);
  const now = Date.parse(PARKED_AT) + THRESHOLD * 10;
  assert.deepEqual(ladder.selectExhaustedNeedsReviewTargets([row], now, THRESHOLD), []);
});

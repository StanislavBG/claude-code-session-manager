/**
 * scheduler-investigation-clean-skip.test.cjs — a run that verified clean
 * (exit 0 + a completed-equivalent verdict) has nothing left to diagnose;
 * spawnInvestigation must decline rather than manufacturing a depth+1
 * fix-of-a-fix PRD for already-shipped work (PRD
 * 812-689-fix-fix-distribute-adminserver-routes).
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/scheduler-investigation-clean-skip.test.cjs
 */

'use strict';

import { test, expect } from 'vitest';
const { shouldSkipInvestigationForCleanRun } = require('../scheduler.cjs');

test('declines for a clean, exit-0 run', () => {
  expect(shouldSkipInvestigationForCleanRun({
    meta: { exitCode: 0 },
    verdicts: { verdict: 'clean' },
  })).toBe(true);
});

test('declines for pass_no_commit_already_shipped, exit-0', () => {
  expect(shouldSkipInvestigationForCleanRun({
    meta: { exitCode: 0 },
    verdicts: { verdict: 'pass_no_commit_already_shipped' },
  })).toBe(true);
});

test('declines for pass_no_commit_target_verified, exit-0', () => {
  expect(shouldSkipInvestigationForCleanRun({
    meta: { exitCode: 0 },
    verdicts: { verdict: 'pass_no_commit_target_verified' },
  })).toBe(true);
});

test('proceeds (does not skip) for exitCode 1', () => {
  expect(shouldSkipInvestigationForCleanRun({
    meta: { exitCode: 1 },
    verdicts: { verdict: 'clean' },
  })).toBe(false);
});

test('proceeds for exit 0 with a non-completed-equivalent verdict', () => {
  expect(shouldSkipInvestigationForCleanRun({
    meta: { exitCode: 0 },
    verdicts: { verdict: 'transcript_errors' },
  })).toBe(false);
});

test('proceeds (fail-open) when verdicts.json is missing', () => {
  expect(shouldSkipInvestigationForCleanRun({
    meta: { exitCode: 0 },
    verdicts: null,
  })).toBe(false);
});

test('proceeds (fail-open) when meta.json is missing', () => {
  expect(shouldSkipInvestigationForCleanRun({
    meta: null,
    verdicts: { verdict: 'clean' },
  })).toBe(false);
});

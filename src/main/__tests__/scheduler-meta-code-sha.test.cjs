/**
 * scheduler-meta-code-sha.test.cjs — unit tests for the SCHEDULER_BOOTED_AT /
 * SCHEDULER_CODE_SHA constants stamped into every run's meta sidecar (PRD
 * 812-fix-commit-guard-retry-on-worktree-ref-visibility-delay): a stale
 * scheduler process is otherwise invisible in the run record, which cost a
 * full investigation to diagnose a false pass_no_commit.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/scheduler-meta-code-sha.test.cjs
 */

'use strict';

import { test, expect } from 'vitest';
const { SCHEDULER_BOOTED_AT, SCHEDULER_CODE_SHA } = require('../scheduler.cjs');

test('SCHEDULER_BOOTED_AT is a valid ISO date string', () => {
  expect(typeof SCHEDULER_BOOTED_AT).toBe('string');
  expect(Number.isNaN(new Date(SCHEDULER_BOOTED_AT).getTime())).toBe(false);
});

test('SCHEDULER_CODE_SHA is null or a short git hex SHA', () => {
  expect(SCHEDULER_CODE_SHA === null || /^[0-9a-f]{7,40}$/.test(SCHEDULER_CODE_SHA)).toBe(true);
});

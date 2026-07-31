/**
 * scheduler-commit-guard-noop.test.cjs — commitGuardVerdict must not flag a
 * legitimate no-op job (a truthful SCHEDULER_VERDICT: PASS, no commit, whose
 * own verifier verdict already independently proved the no-op is correct)
 * for dirt a CONCURRENT actor (e.g. an interactive /process-feedback session
 * writing new PRD .md files into the same repo) left in the working tree.
 *
 * Reproduces the confirmed 2026-07-31 incidents: job
 * 655-needs-review-rca-feedback-hook (verdict pass_no_commit_already_shipped)
 * was flagged uncommitted_changes for a file an interactive session wrote,
 * and job 672-fix-feedback-session-manager similarly. Before this fix, the
 * commit-guard had no exemption for a job whose verifier verdict was already
 * a proven no-op (COMPLETED_EQUIVALENT_VERDICTS) — only for jobSelfCommitted
 * or siblingRunning.
 *
 * Also guards the inverse: a REAL leftover-work case (no legitimate no-op
 * verdict, no sibling, no self-commit) must still be flagged — this fix must
 * not weaken the guard for genuine finish-protocol violations.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/scheduler-commit-guard-noop.test.cjs
 */

'use strict';

import { test, expect } from 'vitest';
const { commitGuardVerdict } = require('../scheduler.cjs');

test('commitGuardVerdict: legitimate no-op verdict (pass_no_commit_already_shipped) + concurrent dirt → no flag (655 incident)', () => {
  const verifyResult = {
    verdict: 'pass_no_commit_already_shipped',
    reason: 'SCHEDULER_VERDICT: PASS with no commit, but every PRD-named deliverable path is already tracked',
    downgradeTo: null,
  };
  const verdict = commitGuardVerdict({
    newlyDirty: ['session-manager-operations/scheduler/prds/816-vitest-register-runverify-test.md'],
    siblingRunning: false,
    jobSelfCommitted: false,
    legitimateNoOp: true,
    verifyResult,
  });
  expect(verdict).toBeNull();
});

test('commitGuardVerdict: legitimate no-op verdict (pass_no_commit_prior_run_verified) + concurrent dirt across multiple files → no flag (672 incident)', () => {
  const verifyResult = {
    verdict: 'pass_no_commit_prior_run_verified',
    reason: 'SCHEDULER_VERDICT: PASS with no commit, but a prior run of this slug landed a commit already',
    downgradeTo: null,
  };
  const verdict = commitGuardVerdict({
    newlyDirty: [
      'session-manager-operations/feedback/processed/a.md',
      'session-manager-operations/feedback/processed/b.md',
      'session-manager-operations/scheduler/prds/816-vitest-register-runverify-test.md',
    ],
    siblingRunning: false,
    jobSelfCommitted: false,
    legitimateNoOp: true,
    verifyResult,
  });
  expect(verdict).toBeNull();
});

test('commitGuardVerdict: REAL leftover work (no legitimate no-op, no sibling, no self-commit) still flags uncommitted_changes', () => {
  const verdict = commitGuardVerdict({
    newlyDirty: ['src/main/someFeature.cjs'],
    siblingRunning: false,
    jobSelfCommitted: false,
    legitimateNoOp: false,
    verifyResult: null,
  });
  expect(verdict).not.toBeNull();
  expect(verdict.verdict).toBe('uncommitted_changes');
  expect(verdict.downgradeTo).toBe('needs_review');
  expect(verdict.reason).toMatch(/finish protocol incomplete/);
});

test('commitGuardVerdict: no newly-dirty files → no flag regardless of other flags', () => {
  const verdict = commitGuardVerdict({
    newlyDirty: [],
    siblingRunning: false,
    jobSelfCommitted: false,
    legitimateNoOp: false,
    verifyResult: null,
  });
  expect(verdict).toBeNull();
});

test('commitGuardVerdict: sibling running skip still works (regression check)', () => {
  const verdict = commitGuardVerdict({
    newlyDirty: ['some/file.md'],
    siblingRunning: true,
    jobSelfCommitted: false,
    legitimateNoOp: false,
    verifyResult: null,
  });
  expect(verdict).toBeNull();
});

test('commitGuardVerdict: self-commit skip still works (regression check)', () => {
  const verdict = commitGuardVerdict({
    newlyDirty: ['some/file.md'],
    siblingRunning: false,
    jobSelfCommitted: true,
    legitimateNoOp: false,
    verifyResult: null,
  });
  expect(verdict).toBeNull();
});

test('commitGuardVerdict: carries forward a non-clean prior verdict as an annotation', () => {
  const verifyResult = {
    verdict: 'transcript_errors',
    reason: 'grep hit an Error string',
    downgradeTo: 'needs_review',
  };
  const verdict = commitGuardVerdict({
    newlyDirty: ['some/file.md'],
    siblingRunning: false,
    jobSelfCommitted: false,
    legitimateNoOp: false,
    verifyResult,
  });
  expect(verdict).not.toBeNull();
  expect(verdict.annotations).toEqual([{ verdict: 'transcript_errors', reason: 'grep hit an Error string' }]);
});

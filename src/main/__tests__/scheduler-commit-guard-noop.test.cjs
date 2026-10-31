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
const { resolveIsFixPlan } = require('../lib/scheduler/fixPlanSlug.cjs');

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

test('commitGuardVerdict: PRD 972 shape — exitCode 0, no commit, clean tree, non-exempt original slug → needs_review (must fail against pre-fix main)', () => {
  const verdict = commitGuardVerdict({
    newlyDirty: [],
    siblingRunning: false,
    jobSelfCommitted: false,
    legitimateNoOp: false,
    isFixPlanJob: false,
    verifyResult: null,
  });
  expect(verdict).not.toBeNull();
  expect(verdict.verdict).toBe('silent_no_op');
  expect(verdict.downgradeTo).toBe('needs_review');
  expect(verdict.reason).toMatch(/finish protocol incomplete/);
});

test('commitGuardVerdict: fix-plan job (523-fix-bounded-fix-plan-retry incident) — no commit, clean tree, isFixPlanJob → no flag', () => {
  const verdict = commitGuardVerdict({
    newlyDirty: [],
    siblingRunning: false,
    jobSelfCommitted: false,
    legitimateNoOp: false,
    isFixPlanJob: true,
    verifyResult: { verdict: 'clean', reason: null, downgradeTo: null },
  });
  expect(verdict).toBeNull();
});

test('commitGuardVerdict: a zero-edit run of a human-authored PRD whose slug merely starts with "fix-" still yields silent_no_op (PRD 1131 — not exempted by name alone)', () => {
  // Mirrors PRD 1126: authored via scheduler_create_prd (isFixPlan stamped
  // false at reconcile time), slug happens to read "fix-...". Feeding the
  // job's own persisted isFixPlan through resolveIsFixPlan (the same call
  // spawnJob makes) must NOT exempt this zero-edit run from the guard.
  const job = { slug: '126-fix-plan-death-reopens-parent', isFixPlan: false };
  const verdict = commitGuardVerdict({
    newlyDirty: [],
    siblingRunning: false,
    jobSelfCommitted: false,
    legitimateNoOp: false,
    isFixPlanJob: resolveIsFixPlan(job.slug, job.isFixPlan),
    verifyResult: null,
  });
  expect(verdict).not.toBeNull();
  expect(verdict.verdict).toBe('silent_no_op');
  expect(verdict.downgradeTo).toBe('needs_review');
});

test('commitGuardVerdict: fix-plan job that DID leave real dirt behind is still flagged (isFixPlanJob only exempts the zero-edit case)', () => {
  const verdict = commitGuardVerdict({
    newlyDirty: ['src/main/someFeature.cjs'],
    siblingRunning: false,
    jobSelfCommitted: false,
    legitimateNoOp: false,
    isFixPlanJob: true,
    verifyResult: null,
  });
  expect(verdict).not.toBeNull();
  expect(verdict.verdict).toBe('uncommitted_changes');
});

test('commitGuardVerdict: COMPLETED_EQUIVALENT verdict, no commit, clean tree → no flag (legitimateNoOp covers the zero-edit case too)', () => {
  const verdict = commitGuardVerdict({
    newlyDirty: [],
    siblingRunning: false,
    jobSelfCommitted: false,
    legitimateNoOp: true,
    isFixPlanJob: false,
    verifyResult: {
      verdict: 'pass_no_commit_already_shipped',
      reason: 'SCHEDULER_VERDICT: PASS with no commit, but every PRD-named deliverable path is already tracked',
      downgradeTo: null,
    },
  });
  expect(verdict).toBeNull();
});

test('commitGuardVerdict: sibling running + zero-edit → no flag (concurrent job makes working-tree evidence unreliable in both directions)', () => {
  const verdict = commitGuardVerdict({
    newlyDirty: [],
    siblingRunning: true,
    jobSelfCommitted: false,
    legitimateNoOp: false,
    isFixPlanJob: false,
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

test('commitGuardVerdict: ranInWorktree=true defeats siblingRunning — clean tree, no self-commit → silent_no_op (PRD 109 shape)', () => {
  const verdict = commitGuardVerdict({
    newlyDirty: [],
    siblingRunning: true,
    ranInWorktree: true,
    jobSelfCommitted: false,
    legitimateNoOp: false,
    isFixPlanJob: false,
    verifyResult: null,
  });
  expect(verdict).not.toBeNull();
  expect(verdict.verdict).toBe('silent_no_op');
  expect(verdict.downgradeTo).toBe('needs_review');
});

test('commitGuardVerdict: identical inputs with ranInWorktree=false → no flag (legacy shared-tree behaviour unchanged)', () => {
  const verdict = commitGuardVerdict({
    newlyDirty: [],
    siblingRunning: true,
    ranInWorktree: false,
    jobSelfCommitted: false,
    legitimateNoOp: false,
    isFixPlanJob: false,
    verifyResult: null,
  });
  expect(verdict).toBeNull();
});

test('commitGuardVerdict: ranInWorktree=true + siblingRunning=true but jobSelfCommitted=true → no flag (self-commit carve-out still applies)', () => {
  const verdict = commitGuardVerdict({
    newlyDirty: [],
    siblingRunning: true,
    ranInWorktree: true,
    jobSelfCommitted: true,
    legitimateNoOp: false,
    isFixPlanJob: false,
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

// ── commitGuardSkipped: the single skip decision spawnJob consults ──────────
const gitTreeGuard = require('../scheduler/gitTreeGuard.cjs');

const v = (verdict, downgradeTo = null) => ({ verdict, reason: 'r', downgradeTo });

test.each([
  ['no verifyResult', null, false, [], false],
  ['downgradeTo pending', v('deps_unmet', 'pending'), false, [], true],
  ['run_commit_not_landed', v('run_commit_not_landed', 'needs_review'), true, ['a.cjs'], true],
  ['clean, in place', v('clean'), false, [], true],
  ['clean, worktree, dirty, no landed commit (fix-plan PASS, edits dropped)', v('clean'), true, ['a.cjs'], false],
  ['clean, worktree, clean tree', v('clean'), true, [], true],
  ['clean, in place, dirty', v('clean'), false, ['a.cjs'], true],
  ['pass_no_commit_already_shipped in place + dirt', v('pass_no_commit_already_shipped'), false, ['a.cjs'], true],
  ['pass_no_commit_prior_run_verified worktree, clean tree', v('pass_no_commit_prior_run_verified'), true, [], true],
  ['pass_no_commit_prior_run_verified worktree, null dirt', v('pass_no_commit_prior_run_verified'), true, null, true],
  ['pass_no_commit_prior_run_verified worktree + dirt', v('pass_no_commit_prior_run_verified'), true, ['a.cjs'], false],
  ['pass_no_commit_target_verified worktree + dirt', v('pass_no_commit_target_verified'), true, ['a.cjs'], false],
  ['pass_no_commit_artifact_verified', v('pass_no_commit_artifact_verified'), false, [], false],
  ['other verdict', v('transcript_errors', 'needs_review'), false, [], false],
])('commitGuardSkipped: %s', (_name, verifyResult, ranInWorktree, newlyDirty, expected) => {
  expect(gitTreeGuard.commitGuardSkipped({ verifyResult, ranInWorktree, newlyDirty })).toBe(expected);
});

test('commitGuardSkipped: clean, worktree, dirty but a commit landed → still skips', () => {
  expect(gitTreeGuard.commitGuardSkipped({ verifyResult: v('clean'), ranInWorktree: true, newlyDirty: ['a.cjs'], landedCommit: 'abc123' })).toBe(true);
});

test('fix-plan worktree job with verdict clean and dirt reaches commitGuardVerdict → uncommitted_changes', () => {
  const verifyResult = v('clean');
  const newlyDirty = ['src/main/edited.cjs'];
  expect(gitTreeGuard.commitGuardSkipped({ verifyResult, ranInWorktree: true, newlyDirty, landedCommit: null })).toBe(false);
  const verdict = commitGuardVerdict({
    newlyDirty,
    siblingRunning: false,
    ranInWorktree: true,
    jobSelfCommitted: false,
    legitimateNoOp: false,
    isFixPlanJob: true,
    verifyResult,
  });
  expect(verdict?.verdict).toBe('uncommitted_changes');
});

test('worktree pass_no_commit_prior_run_verified with one dirty path is not skipped and reaches commitGuardVerdict → uncommitted_changes', () => {
  const verifyResult = v('pass_no_commit_prior_run_verified');
  const newlyDirty = ['src/main/leftover.cjs'];
  expect(gitTreeGuard.commitGuardSkipped({ verifyResult, ranInWorktree: true, newlyDirty })).toBe(false);
  const verdict = commitGuardVerdict({
    newlyDirty,
    siblingRunning: false,
    ranInWorktree: true,
    jobSelfCommitted: false,
    legitimateNoOp: false,
    verifyResult,
  });
  expect(verdict?.verdict).toBe('uncommitted_changes');
});

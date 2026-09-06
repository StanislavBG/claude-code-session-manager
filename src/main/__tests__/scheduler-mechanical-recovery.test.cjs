/**
 * scheduler-mechanical-recovery.test.cjs — PRD 1130: a fix-plan job parked
 * needs_review at investigationDepth >= 2 (isFixPlanBeyondDepthCap,
 * scheduler.cjs) gets no further investigation, and resume-first recovery
 * (selectResumeRecoveryTarget) is hard-gated on verdict 'uncommitted_changes'
 * — so a depth-capped job whose failure is fully mechanical (verdict
 * 'worktree_integration_failed') was previously stranded needs_review
 * forever (216-jupiter-sand-kazekage, 2026-09-06). This adds one bounded,
 * model-free recovery rung, evaluated independently of depth.
 *
 * selectMechanicalRecoveryTarget is the pure eligibility rule (no I/O, no
 * depth check); performMechanicalRecovery is the git plumbing + queue
 * transition, exercised against a real throwaway repo under os.tmpdir()
 * (same pattern as scheduler-leftover-quarantine.test.cjs and
 * scheduler-reap-dead-running-jobs.test.cjs).
 *
 * HOME is overridden to a tmp dir BEFORE requiring scheduler.cjs, since
 * queue.json I/O (mutate/readQueue/writeQueue) is baked into a top-level
 * ROOT const derived from os.homedir() at require time — this test must
 * never touch real state.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/scheduler-mechanical-recovery.test.cjs
 */

'use strict';

import { test, expect, beforeEach, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-mechanical-recovery-test-'));
process.env.HOME = tmpHome;

const scheduler = require('../scheduler.cjs');
const {
  selectMechanicalRecoveryTarget, performMechanicalRecovery, MECHANICALLY_RESOLVABLE_VERDICTS,
} = scheduler;
const jobWorktree = require('../lib/jobWorktree.cjs');

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function initRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  git(['init', '-q'], dir);
  git(['config', 'user.email', 'test@example.com'], dir);
  git(['config', 'user.name', 'Test'], dir);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'original a\n', 'utf8');
  git(['add', '-A'], dir);
  git(['commit', '-q', '-m', 'initial'], dir);
}

function writeProjectQueue(cwd, jobs) {
  const stateDir = path.join(cwd, 'session-manager-operations', 'scheduler', 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'queue.json'), JSON.stringify({ jobs }, null, 2));
  return path.join(stateDir, 'queue.json');
}

function registerActiveProject(cwd, slugDirName) {
  const projectsDir = path.join(tmpHome, '.claude', 'projects');
  const slugDir = path.join(projectsDir, slugDirName);
  fs.mkdirSync(slugDir, { recursive: true });
  fs.writeFileSync(path.join(slugDir, 'transcript.jsonl'), JSON.stringify({ cwd }) + '\n');
}

let originalDisable;

beforeEach(() => {
  originalDisable = process.env.SM_MECHANICAL_RECOVERY_DISABLE;
  delete process.env.SM_MECHANICAL_RECOVERY_DISABLE;
});

afterEach(() => {
  if (originalDisable === undefined) delete process.env.SM_MECHANICAL_RECOVERY_DISABLE;
  else process.env.SM_MECHANICAL_RECOVERY_DISABLE = originalDisable;
});

// ──────────────────────────────────────────── selectMechanicalRecoveryTarget (pure)

function eligibleJob(overrides = {}) {
  return {
    slug: 'depth-capped-fix-plan',
    cwd: '/tmp/whatever-not-read-by-the-selector',
    status: 'needs_review',
    verifierVerdict: 'worktree_integration_failed',
    investigationDepth: 2,
    ...overrides,
  };
}

test('selectMechanicalRecoveryTarget: eligible depth-2 worktree_integration_failed job returns a target, depth never disqualifies it', () => {
  const target = selectMechanicalRecoveryTarget(eligibleJob({ investigationDepth: 5 }));
  expect(target).not.toBeNull();
  expect(target.slug).toBe('depth-capped-fix-plan');
  expect(target.branch).toBe(jobWorktree.branchNameFor('depth-capped-fix-plan'));
});

test('selectMechanicalRecoveryTarget: already-attempted job is not eligible', () => {
  expect(selectMechanicalRecoveryTarget(eligibleJob({ mechanicalRecoveryAttempted: true }))).toBeNull();
});

test('selectMechanicalRecoveryTarget: a verdict outside the closed set is not eligible', () => {
  expect(selectMechanicalRecoveryTarget(eligibleJob({ verifierVerdict: 'uncommitted_changes' }))).toBeNull();
  expect(selectMechanicalRecoveryTarget(eligibleJob({ verifierVerdict: 'transcript_errors' }))).toBeNull();
});

test('selectMechanicalRecoveryTarget: wrong status is not eligible', () => {
  expect(selectMechanicalRecoveryTarget(eligibleJob({ status: 'failed' }))).toBeNull();
  expect(selectMechanicalRecoveryTarget(eligibleJob({ status: 'completed' }))).toBeNull();
});

test('selectMechanicalRecoveryTarget: kill-switch SM_MECHANICAL_RECOVERY_DISABLE=1 always returns null', () => {
  process.env.SM_MECHANICAL_RECOVERY_DISABLE = '1';
  expect(selectMechanicalRecoveryTarget(eligibleJob())).toBeNull();
});

test('MECHANICALLY_RESOLVABLE_VERDICTS: closed set contains exactly worktree_integration_failed', () => {
  expect(Array.from(MECHANICALLY_RESOLVABLE_VERDICTS)).toEqual(['worktree_integration_failed']);
});

// ──────────────────────────────────────────── performMechanicalRecovery (real git + queue)

test('performMechanicalRecovery: successful re-integration transitions needs_review -> completed, clears verifierVerdict, deletes the branch', async () => {
  const projectCwd = path.join(tmpHome, 'proj-success');
  initRepo(projectCwd);
  registerActiveProject(projectCwd, 'proj-success-slug');

  const slug = 'fix-plan-depth2';
  const branch = jobWorktree.branchNameFor(slug);
  // Simulate a job whose worktree branch has one committed change, preserved
  // (never deleted) because its earlier integration attempt failed.
  git(['checkout', '-q', '-b', branch], projectCwd);
  fs.writeFileSync(path.join(projectCwd, 'b.txt'), 'from the fix plan\n', 'utf8');
  git(['add', '-A'], projectCwd);
  git(['commit', '-q', '-m', 'fix plan work'], projectCwd);
  git(['checkout', '-q', 'master'], projectCwd);

  const queuePath = writeProjectQueue(projectCwd, [
    {
      slug,
      status: 'needs_review',
      cwd: projectCwd,
      verifierVerdict: 'worktree_integration_failed',
      investigationDepth: 2,
      error: 'worktree branch integration FAILED (merge failed) — branch preserved for manual recovery',
    },
  ]);

  const target = selectMechanicalRecoveryTarget({ slug, cwd: projectCwd, status: 'needs_review', verifierVerdict: 'worktree_integration_failed' });
  expect(target).not.toBeNull();

  await performMechanicalRecovery({ slug, cwd: projectCwd }, target);

  const jobs = JSON.parse(fs.readFileSync(queuePath, 'utf8')).jobs;
  expect(jobs).toHaveLength(1);
  expect(jobs[0].status).toBe('completed');
  expect(jobs[0].verifierVerdict).toBeUndefined();
  expect(jobs[0].mechanicalRecoveryAttempted).toBe(true);
  expect(jobs[0].statusHistory.at(-1).source).toBe('scheduler:mechanicalRecovery');
  expect(fs.readFileSync(path.join(projectCwd, 'b.txt'), 'utf8')).toBe('from the fix plan\n');
  // The branch, now merged, is cleaned up.
  const branchList = git(['branch', '--list', branch], projectCwd);
  expect(branchList.trim()).toBe('');
});

test('performMechanicalRecovery: a real merge conflict keeps the job needs_review, stamps mechanicalRecoveryAttempted, appends the failure text', async () => {
  const projectCwd = path.join(tmpHome, 'proj-conflict');
  initRepo(projectCwd);
  registerActiveProject(projectCwd, 'proj-conflict-slug');

  const slug = 'fix-plan-conflict';
  const branch = jobWorktree.branchNameFor(slug);
  git(['checkout', '-q', '-b', branch], projectCwd);
  fs.writeFileSync(path.join(projectCwd, 'a.txt'), 'branch version\n', 'utf8');
  git(['add', '-A'], projectCwd);
  git(['commit', '-q', '-m', 'branch edits a.txt'], projectCwd);
  git(['checkout', '-q', 'master'], projectCwd);
  // Main tree diverges on the SAME line — a genuine, unresolvable conflict.
  fs.writeFileSync(path.join(projectCwd, 'a.txt'), 'main version\n', 'utf8');
  git(['add', '-A'], projectCwd);
  git(['commit', '-q', '-m', 'main edits a.txt'], projectCwd);

  const queuePath = writeProjectQueue(projectCwd, [
    { slug, status: 'needs_review', cwd: projectCwd, verifierVerdict: 'worktree_integration_failed', investigationDepth: 3, error: 'prior failure note' },
  ]);

  const target = selectMechanicalRecoveryTarget({ slug, cwd: projectCwd, status: 'needs_review', verifierVerdict: 'worktree_integration_failed' });
  await performMechanicalRecovery({ slug, cwd: projectCwd }, target);

  const jobs = JSON.parse(fs.readFileSync(queuePath, 'utf8')).jobs;
  expect(jobs[0].status).toBe('needs_review');
  expect(jobs[0].mechanicalRecoveryAttempted).toBe(true);
  expect(jobs[0].error).toMatch(/prior failure note/);
  expect(jobs[0].error).toMatch(/Mechanical recovery retry failed/);
  // The branch is preserved for manual recovery, exactly like the original failure.
  const branchList = git(['branch', '--list', branch], projectCwd);
  expect(branchList.trim()).not.toBe('');
});

test('performMechanicalRecovery: a branch that no longer exists is handled without throwing, and stamps an explicit reason', async () => {
  const projectCwd = path.join(tmpHome, 'proj-missing-branch');
  initRepo(projectCwd);
  registerActiveProject(projectCwd, 'proj-missing-branch-slug');

  const slug = 'fix-plan-already-merged';
  const queuePath = writeProjectQueue(projectCwd, [
    { slug, status: 'needs_review', cwd: projectCwd, verifierVerdict: 'worktree_integration_failed', investigationDepth: 2 },
  ]);

  const target = selectMechanicalRecoveryTarget({ slug, cwd: projectCwd, status: 'needs_review', verifierVerdict: 'worktree_integration_failed' });

  await expect(performMechanicalRecovery({ slug, cwd: projectCwd }, target)).resolves.not.toThrow();

  const jobs = JSON.parse(fs.readFileSync(queuePath, 'utf8')).jobs;
  expect(jobs[0].status).toBe('needs_review');
  expect(jobs[0].mechanicalRecoveryAttempted).toBe(true);
  expect(jobs[0].error).toMatch(/not found/);
});

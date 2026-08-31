/**
 * jobWorktree.test.cjs — PRD 994: per-job `git worktree` isolation.
 *
 * Exercises the real `git worktree` plumbing against throwaway repos under
 * os.tmpdir() (fast — no network, no Electron). Covers: create/integrate/
 * cleanup happy path, the two documented fallback reasons (non-git cwd, dirty
 * base tree), the concurrency cap, the kill-switch env var, a real merge
 * conflict surfacing as an explicit integration failure (branch preserved,
 * not silently discarded), and boot-time reconciliation of a leaked worktree.
 *
 * Run: timeout 120 npx vitest run src/main/lib/__tests__/jobWorktree.test.cjs
 */

'use strict';

import { test, expect, beforeEach, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const jobWorktree = require('../jobWorktree.cjs');

let tmpRoot;
let repoCwd;
let originalDisable;
let originalMax;

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function initRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  git(['init', '-q'], dir);
  git(['config', 'user.email', 'test@example.com'], dir);
  git(['config', 'user.name', 'Test'], dir);
  fs.writeFileSync(path.join(dir, 'README.md'), 'hello\n', 'utf8');
  git(['add', '-A'], dir);
  git(['commit', '-q', '-m', 'initial'], dir);
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-jobworktree-'));
  repoCwd = path.join(tmpRoot, 'repo');
  initRepo(repoCwd);
  originalDisable = process.env.SM_JOB_WORKTREE_DISABLE;
  originalMax = process.env.SM_JOB_WORKTREE_MAX;
  delete process.env.SM_JOB_WORKTREE_DISABLE;
  delete process.env.SM_JOB_WORKTREE_MAX;
  jobWorktree._resetActiveWorktreeCountForTests(0);
});

afterEach(async () => {
  if (originalDisable === undefined) delete process.env.SM_JOB_WORKTREE_DISABLE;
  else process.env.SM_JOB_WORKTREE_DISABLE = originalDisable;
  if (originalMax === undefined) delete process.env.SM_JOB_WORKTREE_MAX;
  else process.env.SM_JOB_WORKTREE_MAX = originalMax;
  // Best-effort: prune any worktree this test created before removing the repo.
  try { await jobWorktree.reconcileWorktreesOnBoot([repoCwd]); } catch { /* ignore */ }
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test('createJobWorktree creates a linked worktree on a fresh branch from HEAD', async () => {
  const slug = 'test-slug-create';
  const result = await jobWorktree.createJobWorktree({ cwd: repoCwd, slug });
  expect(result.ok).toBe(true);
  expect(fs.existsSync(result.dir)).toBe(true);
  expect(fs.existsSync(path.join(result.dir, 'README.md'))).toBe(true);
  expect(result.branch).toBe(`sm-job/${slug}`);

  await jobWorktree.cleanupJobWorktree({ cwd: repoCwd, dir: result.dir, branch: result.branch });
  expect(fs.existsSync(result.dir)).toBe(false);
});

test('a commit made inside the worktree becomes visible on the main tree HEAD after integrateJobBranch', async () => {
  const slug = 'test-slug-integrate';
  const worktree = await jobWorktree.createJobWorktree({ cwd: repoCwd, slug });
  expect(worktree.ok).toBe(true);

  fs.writeFileSync(path.join(worktree.dir, 'new-file.txt'), 'job output\n', 'utf8');
  git(['add', '-A'], worktree.dir);
  git(['commit', '-q', '-m', 'job commit'], worktree.dir);
  const jobCommitSha = git(['rev-parse', 'HEAD'], worktree.dir).trim();

  const headBefore = git(['rev-parse', 'HEAD'], repoCwd).trim();
  const outcome = await jobWorktree.integrateJobBranch({ cwd: repoCwd, branch: worktree.branch, slug });
  expect(outcome.ok).toBe(true);
  expect(outcome.integrated).toBe(true);

  const headAfter = git(['rev-parse', 'HEAD'], repoCwd).trim();
  expect(headAfter).not.toBe(headBefore);
  // Fast-forward, since the main tree never advanced independently.
  expect(headAfter).toBe(jobCommitSha);
  expect(fs.existsSync(path.join(repoCwd, 'new-file.txt'))).toBe(true);

  await jobWorktree.cleanupJobWorktree({ cwd: repoCwd, dir: worktree.dir, branch: worktree.branch });
  expect(fs.existsSync(worktree.dir)).toBe(false);
});

test('integrateJobBranch is a no-op (integrated:false) when the branch has no new commits', async () => {
  const slug = 'test-slug-noop';
  const worktree = await jobWorktree.createJobWorktree({ cwd: repoCwd, slug });
  const outcome = await jobWorktree.integrateJobBranch({ cwd: repoCwd, branch: worktree.branch, slug });
  expect(outcome.ok).toBe(true);
  expect(outcome.integrated).toBe(false);
  await jobWorktree.cleanupJobWorktree({ cwd: repoCwd, dir: worktree.dir, branch: worktree.branch });
});

test('a real merge conflict surfaces as an explicit integration failure and preserves the branch', async () => {
  const slug = 'test-slug-conflict';
  const worktree = await jobWorktree.createJobWorktree({ cwd: repoCwd, slug });

  // Job edits README.md in its worktree and commits.
  fs.writeFileSync(path.join(worktree.dir, 'README.md'), 'job edit\n', 'utf8');
  git(['add', '-A'], worktree.dir);
  git(['commit', '-q', '-m', 'job edits README'], worktree.dir);

  // Main tree ALSO advances with a conflicting edit to the same line.
  fs.writeFileSync(path.join(repoCwd, 'README.md'), 'main tree edit\n', 'utf8');
  git(['add', '-A'], repoCwd);
  git(['commit', '-q', '-m', 'main tree edits README'], repoCwd);

  const outcome = await jobWorktree.integrateJobBranch({ cwd: repoCwd, branch: worktree.branch, slug });
  expect(outcome.ok).toBe(false);
  expect(outcome.reason).toMatch(/conflict|merge failed/i);

  // cwd must not be left mid-merge.
  const status = git(['status', '--porcelain'], repoCwd);
  expect(status.trim()).toBe('');

  // Branch is preserved (keepBranch) — the job's commit is not discarded.
  await jobWorktree.cleanupJobWorktree({ cwd: repoCwd, dir: worktree.dir, branch: worktree.branch, keepBranch: true });
  const branches = git(['branch', '--list', worktree.branch], repoCwd);
  expect(branches).toContain(worktree.branch.replace('sm-job/', ''));
});

test('falls back with a reason for a non-git cwd', async () => {
  const nonGitDir = path.join(tmpRoot, 'not-a-repo');
  fs.mkdirSync(nonGitDir, { recursive: true });
  const result = await jobWorktree.createJobWorktree({ cwd: nonGitDir, slug: 'x' });
  expect(result.ok).toBe(false);
  expect(result.reason).toMatch(/not a git repository/);
});

test('falls back with a reason for a dirty base tree with a modified TRACKED file (never silently drops uncommitted human WIP)', async () => {
  fs.writeFileSync(path.join(repoCwd, 'README.md'), 'uncommitted tracked edit\n', 'utf8');
  const result = await jobWorktree.createJobWorktree({ cwd: repoCwd, slug: 'x' });
  expect(result.ok).toBe(false);
  expect(result.reason).toMatch(/uncommitted changes/);
});

test('falls back once the concurrency cap is reached, and recovers after cleanup', async () => {
  process.env.SM_JOB_WORKTREE_MAX = '1';
  const first = await jobWorktree.createJobWorktree({ cwd: repoCwd, slug: 'cap-1' });
  expect(first.ok).toBe(true);

  const second = await jobWorktree.createJobWorktree({ cwd: repoCwd, slug: 'cap-2' });
  expect(second.ok).toBe(false);
  expect(second.reason).toMatch(/cap reached/);

  await jobWorktree.cleanupJobWorktree({ cwd: repoCwd, dir: first.dir, branch: first.branch });

  const third = await jobWorktree.createJobWorktree({ cwd: repoCwd, slug: 'cap-3' });
  expect(third.ok).toBe(true);
  await jobWorktree.cleanupJobWorktree({ cwd: repoCwd, dir: third.dir, branch: third.branch });
});

test('SM_JOB_WORKTREE_DISABLE=1 restores in-place behaviour', async () => {
  process.env.SM_JOB_WORKTREE_DISABLE = '1';
  const result = await jobWorktree.createJobWorktree({ cwd: repoCwd, slug: 'x' });
  expect(result.ok).toBe(false);
  expect(result.reason).toMatch(/SM_JOB_WORKTREE_DISABLE/);
});

test('reconcileWorktreesOnBoot removes a leaked worktree (simulated crash) and its branch', async () => {
  const slug = 'test-slug-leak';
  const worktree = await jobWorktree.createJobWorktree({ cwd: repoCwd, slug });
  expect(fs.existsSync(worktree.dir)).toBe(true);
  // Simulate a crash: the in-memory counter resets (as it would on restart)
  // and nothing calls cleanupJobWorktree — the checkout is left registered.
  jobWorktree._resetActiveWorktreeCountForTests(0);

  await jobWorktree.reconcileWorktreesOnBoot([repoCwd]);

  expect(fs.existsSync(worktree.dir)).toBe(false);
  const branches = git(['branch', '--list', worktree.branch], repoCwd);
  expect(branches.trim()).toBe('');
});

test('reconcileWorktreesOnBoot never touches a worktree outside WORKTREE_ROOT', async () => {
  const humanWorktreeDir = path.join(tmpRoot, 'human-made-worktree');
  git(['worktree', 'add', '-b', 'human-branch', humanWorktreeDir, 'HEAD'], repoCwd);
  await jobWorktree.reconcileWorktreesOnBoot([repoCwd]);
  expect(fs.existsSync(humanWorktreeDir)).toBe(true);
  // cleanup so afterEach's rm doesn't leave a dangling worktree registration.
  git(['worktree', 'remove', '--force', humanWorktreeDir], repoCwd);
});

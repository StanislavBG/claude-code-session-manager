/**
 * branchSweep.test.cjs — PRD 1135: recovering `sm-job/<slug>` branches left
 * stranded (unmerged, owning job row terminal or gone) never gets swept away
 * by hand months later.
 *
 * Exercises the real `git` plumbing against throwaway repos under
 * os.tmpdir() (fast — no network, no Electron).
 *
 * Run: timeout 120 npx vitest run src/main/lib/__tests__/branchSweep.test.cjs
 */
'use strict';

import { test, expect, beforeEach, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { sweepStrandedJobBranches } = require('../branchSweep.cjs');

let tmpRoot;
let repoCwd;
let worktreeDir;

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
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-branchsweep-'));
  repoCwd = path.join(tmpRoot, 'repo');
  initRepo(repoCwd);
  delete process.env.SM_BRANCH_SWEEP_DISABLE;
});

afterEach(() => {
  if (worktreeDir && fs.existsSync(worktreeDir)) {
    try { git(['worktree', 'remove', '--force', worktreeDir], repoCwd); } catch { /* best effort */ }
  }
  worktreeDir = undefined;
  delete process.env.SM_BRANCH_SWEEP_DISABLE;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

/** Create an `sm-job/<slug>` branch with one commit beyond HEAD, without checking it out. */
function makeStrandedBranch(cwd, slug, fileContents = 'stranded work\n') {
  const branch = `sm-job/${slug}`;
  git(['branch', branch], cwd);
  const tmpCheckout = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-branchsweep-checkout-'));
  git(['worktree', 'add', '-q', tmpCheckout, branch], cwd);
  fs.writeFileSync(path.join(tmpCheckout, `${slug}.txt`), fileContents, 'utf8');
  git(['add', '-A'], tmpCheckout);
  git(['commit', '-q', '-m', `job ${slug} work`], tmpCheckout);
  git(['worktree', 'remove', '--force', tmpCheckout], cwd);
  return branch;
}

test('stranded branch with a terminal job row is integrated', async () => {
  const branch = makeStrandedBranch(repoCwd, 'alpha');
  const jobs = [{ slug: 'alpha', status: 'completed' }];
  const { results } = await sweepStrandedJobBranches({ cwd: repoCwd, jobs, attemptedBranches: new Set() });
  const r = results.find((x) => x.branch === branch);
  expect(r.action).toBe('integrated');
  expect(fs.existsSync(path.join(repoCwd, 'alpha.txt'))).toBe(true);
});

test('stranded branch with NO job row at all is also integrated', async () => {
  const branch = makeStrandedBranch(repoCwd, 'ghost');
  const { results } = await sweepStrandedJobBranches({ cwd: repoCwd, jobs: [], attemptedBranches: new Set() });
  const r = results.find((x) => x.branch === branch);
  expect(r.action).toBe('integrated');
});

test('branch already merged into HEAD is a silent no-op', async () => {
  const branch = makeStrandedBranch(repoCwd, 'bravo');
  git(['merge', '--no-ff', '--no-edit', branch], repoCwd);
  const jobs = [{ slug: 'bravo', status: 'completed' }];
  const { results } = await sweepStrandedJobBranches({ cwd: repoCwd, jobs, attemptedBranches: new Set() });
  const r = results.find((x) => x.branch === branch);
  expect(r.action).toBe('no-op-merged');
});

test('branch checked out in a live worktree is skipped entirely', async () => {
  const branch = makeStrandedBranch(repoCwd, 'charlie');
  worktreeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-branchsweep-live-'));
  git(['worktree', 'add', '-q', worktreeDir, branch], repoCwd);
  const jobs = [{ slug: 'charlie', status: 'running' }];
  const { results } = await sweepStrandedJobBranches({ cwd: repoCwd, jobs, attemptedBranches: new Set() });
  const r = results.find((x) => x.branch === branch);
  expect(r.action).toBe('skip-checked-out');
});

test('branch owned by a NON-terminal job row is left alone, never integrated', async () => {
  const branch = makeStrandedBranch(repoCwd, 'delta');
  const jobs = [{ slug: 'delta', status: 'needs_review' }];
  const { results } = await sweepStrandedJobBranches({ cwd: repoCwd, jobs, attemptedBranches: new Set() });
  const r = results.find((x) => x.branch === branch);
  expect(r.action).toBe('skip-active-row');
  expect(fs.existsSync(path.join(repoCwd, 'delta.txt'))).toBe(false);
});

test('conflicting branch is flagged, never forced, and the branch is never deleted', async () => {
  // Same path committed differently on both HEAD and the branch → real conflict.
  fs.writeFileSync(path.join(repoCwd, 'shared.txt'), 'main tree version\n', 'utf8');
  git(['add', '-A'], repoCwd);
  git(['commit', '-q', '-m', 'main tree edits shared.txt'], repoCwd);

  const branch = 'sm-job/echo';
  git(['branch', branch, 'HEAD~1'], repoCwd);
  const tmpCheckout = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-branchsweep-conflict-'));
  git(['worktree', 'add', '-q', tmpCheckout, branch], repoCwd);
  fs.writeFileSync(path.join(tmpCheckout, 'shared.txt'), 'branch version — conflicts\n', 'utf8');
  git(['add', '-A'], tmpCheckout);
  git(['commit', '-q', '-m', 'job echo edits shared.txt'], tmpCheckout);
  git(['worktree', 'remove', '--force', tmpCheckout], repoCwd);

  const jobs = [{ slug: 'echo', status: 'failed' }];
  const { results } = await sweepStrandedJobBranches({ cwd: repoCwd, jobs, attemptedBranches: new Set() });
  const r = results.find((x) => x.branch === branch);
  expect(r.action).toBe('conflict');
  expect(r.integration.ok).toBe(false);
  // Branch itself must survive a conflict, untouched.
  const stillExists = git(['rev-parse', '--verify', branch], repoCwd).trim();
  expect(stillExists.length).toBe(40);
});

test('a branch is retried at most once per process lifetime via the shared attempted set', async () => {
  fs.writeFileSync(path.join(repoCwd, 'shared2.txt'), 'main\n', 'utf8');
  git(['add', '-A'], repoCwd);
  git(['commit', '-q', '-m', 'main edits shared2'], repoCwd);
  const branch = 'sm-job/foxtrot';
  git(['branch', branch, 'HEAD~1'], repoCwd);
  const tmpCheckout = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-branchsweep-retry-'));
  git(['worktree', 'add', '-q', tmpCheckout, branch], repoCwd);
  fs.writeFileSync(path.join(tmpCheckout, 'shared2.txt'), 'branch — conflicts\n', 'utf8');
  git(['add', '-A'], tmpCheckout);
  git(['commit', '-q', '-m', 'job foxtrot edits shared2'], tmpCheckout);
  git(['worktree', 'remove', '--force', tmpCheckout], repoCwd);

  const jobs = [{ slug: 'foxtrot', status: 'failed' }];
  const attemptedBranches = new Set();
  const first = await sweepStrandedJobBranches({ cwd: repoCwd, jobs, attemptedBranches });
  expect(first.results.find((x) => x.branch === branch).action).toBe('conflict');
  const second = await sweepStrandedJobBranches({ cwd: repoCwd, jobs, attemptedBranches });
  expect(second.results.find((x) => x.branch === branch).action).toBe('skip-already-attempted');
});

test('SM_BRANCH_SWEEP_DISABLE=1 restores today\'s behaviour exactly — no scan, no integration', async () => {
  makeStrandedBranch(repoCwd, 'golf');
  process.env.SM_BRANCH_SWEEP_DISABLE = '1';
  const jobs = [{ slug: 'golf', status: 'completed' }];
  const { results } = await sweepStrandedJobBranches({ cwd: repoCwd, jobs, attemptedBranches: new Set() });
  expect(results).toEqual([]);
  expect(fs.existsSync(path.join(repoCwd, 'golf.txt'))).toBe(false);
});

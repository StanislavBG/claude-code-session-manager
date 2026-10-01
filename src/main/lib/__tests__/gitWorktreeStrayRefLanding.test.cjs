/**
 * gitWorktreeStrayRefLanding.test.cjs — `integrateBranch`'s `allowRefLanding`
 * option. The main checkout being on some OTHER branch than expected used to
 * always refuse (`failureKind: 'stray_checkout'`) and wait for a human. With
 * `allowRefLanding: true`, mechanical recovery can instead land the job
 * branch straight onto the expected branch's ref via `integrateOntoRef` — a
 * pure object-database CAS that never checks out, resets, or touches the
 * stray checkout's working tree.
 *
 * Exercises the real `git worktree`/`git update-ref` plumbing against
 * throwaway repos under `os.tmpdir()` (fast — no network, no Electron).
 *
 * Run: timeout 120 npx vitest run src/main/lib/__tests__/gitWorktreeStrayRefLanding.test.cjs
 */

'use strict';

import { test, expect, beforeEach, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const gitWorktree = require('../gitWorktree.cjs');

let tmpRoot;
let repoCwd;
let originalWorktreeRoot;
let originalRefLandingDisable;

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function initRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  git(['init', '-q', '-b', 'main'], dir);
  git(['config', 'user.email', 'test@example.com'], dir);
  git(['config', 'user.name', 'Test'], dir);
  fs.writeFileSync(path.join(dir, 'README.md'), 'hello\n', 'utf8');
  git(['add', '-A'], dir);
  git(['commit', '-q', '-m', 'initial'], dir);
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'sm-stray-ref-landing-'));
  repoCwd = path.join(tmpRoot, 'repo');
  initRepo(repoCwd);
  // Every job worktree created below lands under THIS throwaway root, never
  // the live job-worktree root.
  originalWorktreeRoot = process.env.SM_WORKTREE_ROOT;
  process.env.SM_WORKTREE_ROOT = path.join(tmpRoot, 'worktrees');
  originalRefLandingDisable = process.env.SM_REF_LANDING_DISABLE;
  delete process.env.SM_REF_LANDING_DISABLE;
  gitWorktree._resetActiveWorktreeCountForTests('job', 0);
  gitWorktree._resetObservedWorktreeCountCacheForTests();
});

afterEach(() => {
  const restore = (name, val) => { if (val === undefined) delete process.env[name]; else process.env[name] = val; };
  restore('SM_WORKTREE_ROOT', originalWorktreeRoot);
  restore('SM_REF_LANDING_DISABLE', originalRefLandingDisable);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test('allowRefLanding lands the job branch onto main while the checkout stays on stray, untouched', async () => {
  const slug = 'ref-landing-success';
  const worktree = await gitWorktree.createJobWorktree({ cwd: repoCwd, slug, fromRef: 'main' });
  expect(worktree.ok).toBe(true);
  fs.writeFileSync(path.join(worktree.dir, 'from-job.txt'), 'job output\n', 'utf8');
  git(['add', '-A'], worktree.dir);
  git(['commit', '-q', '-m', 'job commit'], worktree.dir);
  const branchHead = git(['rev-parse', worktree.branch], repoCwd).trim();

  git(['checkout', '-q', '-b', 'stray'], repoCwd);
  fs.writeFileSync(path.join(repoCwd, 'stray-wip.txt'), 'uncommitted work\n', 'utf8');
  const statusBefore = git(['status', '--porcelain'], repoCwd);
  const mainBefore = git(['rev-parse', 'main'], repoCwd).trim();

  const outcome = await gitWorktree.integrateBranch({
    cwd: repoCwd, branch: worktree.branch, key: slug, kind: 'job', allowRefLanding: true,
  });

  expect(outcome.ok).toBe(true);
  expect(outcome.integrated).toBe(true);
  expect(outcome.viaRef).toBe(true);
  expect(outcome.fastForward).toBe(false);
  expect(outcome.sha).toBe(branchHead);

  // The main ref advanced and contains the job's commit.
  const mainAfter = git(['rev-parse', 'main'], repoCwd).trim();
  expect(mainAfter).toBe(branchHead);
  expect(mainAfter).not.toBe(mainBefore);
  expect(git(['log', 'main', '--name-only', '--format='], repoCwd)).toContain('from-job.txt');

  // The checkout never moved, and its uncommitted file is unchanged.
  expect(await gitWorktree.getCurrentBranch(repoCwd)).toBe('stray');
  expect(git(['status', '--porcelain'], repoCwd)).toBe(statusBefore);
  expect(fs.readFileSync(path.join(repoCwd, 'stray-wip.txt'), 'utf8')).toBe('uncommitted work\n');

  await gitWorktree.cleanupJobWorktree({ cwd: repoCwd, dir: worktree.dir, branch: worktree.branch });
});

test('without allowRefLanding, a stray checkout still refuses exactly as today', async () => {
  const slug = 'ref-landing-no-flag';
  const worktree = await gitWorktree.createJobWorktree({ cwd: repoCwd, slug, fromRef: 'main' });
  fs.writeFileSync(path.join(worktree.dir, 'from-job-2.txt'), 'job output\n', 'utf8');
  git(['add', '-A'], worktree.dir);
  git(['commit', '-q', '-m', 'job commit'], worktree.dir);

  git(['checkout', '-q', '-b', 'stray'], repoCwd);
  const mainBefore = git(['rev-parse', 'main'], repoCwd).trim();

  const outcome = await gitWorktree.integrateBranch({ cwd: repoCwd, branch: worktree.branch, key: slug, kind: 'job' });

  expect(outcome.ok).toBe(false);
  expect(outcome.failureKind).toBe('stray_checkout');
  expect(outcome.expectedBranch).toBe('main');
  expect(outcome.actualBranch).toBe('stray');
  expect(git(['rev-parse', 'main'], repoCwd).trim()).toBe(mainBefore);

  await gitWorktree.cleanupJobWorktree({ cwd: repoCwd, dir: worktree.dir, branch: worktree.branch, keepBranch: true });
  git(['branch', '-D', worktree.branch], repoCwd);
});

test('SM_REF_LANDING_DISABLE=1 forces the stray_checkout refusal even with allowRefLanding', async () => {
  const slug = 'ref-landing-kill-switch';
  const worktree = await gitWorktree.createJobWorktree({ cwd: repoCwd, slug, fromRef: 'main' });
  fs.writeFileSync(path.join(worktree.dir, 'from-job-3.txt'), 'job output\n', 'utf8');
  git(['add', '-A'], worktree.dir);
  git(['commit', '-q', '-m', 'job commit'], worktree.dir);

  git(['checkout', '-q', '-b', 'stray'], repoCwd);
  const mainBefore = git(['rev-parse', 'main'], repoCwd).trim();

  process.env.SM_REF_LANDING_DISABLE = '1';
  const outcome = await gitWorktree.integrateBranch({
    cwd: repoCwd, branch: worktree.branch, key: slug, kind: 'job', allowRefLanding: true,
  });

  expect(outcome.ok).toBe(false);
  expect(outcome.failureKind).toBe('stray_checkout');
  expect(git(['rev-parse', 'main'], repoCwd).trim()).toBe(mainBefore);

  await gitWorktree.cleanupJobWorktree({ cwd: repoCwd, dir: worktree.dir, branch: worktree.branch, keepBranch: true });
  git(['branch', '-D', worktree.branch], repoCwd);
});

test('a job branch with no new commits past main returns the no-new-commits shape', async () => {
  const slug = 'ref-landing-no-new-commits';
  // fromRef: 'main' with no commit made afterward — the branch sits exactly
  // at main's tip, same as a job whose worktree never changed anything.
  const worktree = await gitWorktree.createJobWorktree({ cwd: repoCwd, slug, fromRef: 'main' });

  git(['checkout', '-q', '-b', 'stray'], repoCwd);
  const mainBefore = git(['rev-parse', 'main'], repoCwd).trim();

  const outcome = await gitWorktree.integrateBranch({
    cwd: repoCwd, branch: worktree.branch, key: slug, kind: 'job', allowRefLanding: true,
  });

  expect(outcome).toEqual({ ok: true, integrated: false, reason: 'branch has no new commits' });
  expect(git(['rev-parse', 'main'], repoCwd).trim()).toBe(mainBefore);
  expect(await gitWorktree.getCurrentBranch(repoCwd)).toBe('stray');

  await gitWorktree.cleanupJobWorktree({ cwd: repoCwd, dir: worktree.dir, branch: worktree.branch, keepBranch: true });
  git(['branch', '-D', worktree.branch], repoCwd);
});

test('a genuine content conflict against main returns the conflict shape with baseHeadSha', async () => {
  const slug = 'ref-landing-conflict';
  const worktree = await gitWorktree.createJobWorktree({ cwd: repoCwd, slug, fromRef: 'main' });
  fs.writeFileSync(path.join(worktree.dir, 'README.md'), 'job version\n', 'utf8');
  git(['add', '-A'], worktree.dir);
  git(['commit', '-q', '-m', 'job edits README'], worktree.dir);

  // main advances with a conflicting edit to the SAME file, while repoCwd is
  // still on main — a genuine divergence, not just "behind."
  fs.writeFileSync(path.join(repoCwd, 'README.md'), 'main version\n', 'utf8');
  git(['add', '-A'], repoCwd);
  git(['commit', '-q', '-m', 'main edits README'], repoCwd);
  const mainSha = git(['rev-parse', 'main'], repoCwd).trim();

  git(['checkout', '-q', '-b', 'stray'], repoCwd);

  const outcome = await gitWorktree.integrateBranch({
    cwd: repoCwd, branch: worktree.branch, key: slug, kind: 'job', allowRefLanding: true,
  });

  expect(outcome.ok).toBe(false);
  expect(outcome.failureKind).toBe('content_conflict');
  expect(outcome.conflictedPaths).toContain('README.md');
  expect(outcome.baseHeadSha).toBe(mainSha);
  expect(outcome.reason).toMatch(/merge failed \(likely a real content conflict\)/);

  // Nothing landed: main never moved.
  expect(git(['rev-parse', 'main'], repoCwd).trim()).toBe(mainSha);
  expect(await gitWorktree.getCurrentBranch(repoCwd)).toBe('stray');

  await gitWorktree.cleanupJobWorktree({ cwd: repoCwd, dir: worktree.dir, branch: worktree.branch, keepBranch: true });
  git(['branch', '-D', worktree.branch], repoCwd);
});

test('main checked out in another worktree falls back to the original stray_checkout failure', async () => {
  const slug = 'ref-landing-target-checked-out';
  const worktree = await gitWorktree.createJobWorktree({ cwd: repoCwd, slug, fromRef: 'main' });
  fs.writeFileSync(path.join(worktree.dir, 'from-job-6.txt'), 'job output\n', 'utf8');
  git(['add', '-A'], worktree.dir);
  git(['commit', '-q', '-m', 'job commit'], worktree.dir);

  git(['checkout', '-q', '-b', 'stray'], repoCwd);
  // A second, independent worktree checks main out directly — now the ref
  // mechanical recovery would land onto is itself live elsewhere.
  const otherDir = path.join(tmpRoot, 'other-main-checkout');
  git(['worktree', 'add', otherDir, 'main'], repoCwd);
  const mainBefore = git(['rev-parse', 'main'], repoCwd).trim();

  const outcome = await gitWorktree.integrateBranch({
    cwd: repoCwd, branch: worktree.branch, key: slug, kind: 'job', allowRefLanding: true,
  });

  // Reported the same way as "no flag" would be — never the internal
  // target_checked_out kind, which no other caller recognizes.
  expect(outcome.ok).toBe(false);
  expect(outcome.failureKind).toBe('stray_checkout');
  expect(outcome.expectedBranch).toBe('main');
  expect(outcome.actualBranch).toBe('stray');
  expect(git(['rev-parse', 'main'], repoCwd).trim()).toBe(mainBefore);

  git(['worktree', 'remove', '--force', otherDir], repoCwd);
  await gitWorktree.cleanupJobWorktree({ cwd: repoCwd, dir: worktree.dir, branch: worktree.branch, keepBranch: true });
  git(['branch', '-D', worktree.branch], repoCwd);
});

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
  // The branch forked straight off main's tip and main never moved — this is
  // a pure fast-forward, not a merge commit.
  expect(outcome.fastForward).toBe(true);
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

test('a genuine content conflict against main returns the conflict shape, no baseHeadSha on the ref path', async () => {
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
  // The ref path never reads baseHeadSha back out of its own result (only
  // the in-checkout path's shape is matched against it, in
  // stampIntegrationFailure) — so it is dropped here rather than computed
  // and left unused.
  expect(outcome.baseHeadSha).toBeUndefined();
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

test('a worktree mid-rebase of main refuses to land, even though main itself is free', async () => {
  const slug = 'ref-landing-rebase-elsewhere';
  const worktree = await gitWorktree.createJobWorktree({ cwd: repoCwd, slug, fromRef: 'main' });
  fs.writeFileSync(path.join(worktree.dir, 'from-job-rebase.txt'), 'job output\n', 'utf8');
  git(['add', '-A'], worktree.dir);
  git(['commit', '-q', '-m', 'job commit'], worktree.dir);

  git(['checkout', '-q', '-b', 'stray'], repoCwd);
  const mainAtFork = git(['rev-parse', 'main'], repoCwd).trim();

  // main gets a commit via a second worktree (repoCwd/stray is never
  // touched), and a sibling branch `side` — cut from the commit BEFORE that
  // one — gets a conflicting commit to the same file. Rebasing main onto
  // side inside that second worktree then stops on a real conflict,
  // detaching its HEAD — so it drops out of `git worktree list
  // --porcelain`'s `branch` lines, which is exactly the gap this guard closes.
  const wt2Dir = path.join(tmpRoot, 'wt2');
  git(['worktree', 'add', '-q', wt2Dir, 'main'], repoCwd);
  fs.writeFileSync(path.join(wt2Dir, 'f.txt'), 'from main\n', 'utf8');
  git(['add', '-A'], wt2Dir);
  git(['commit', '-q', '-m', 'main edits f.txt'], wt2Dir);

  git(['branch', 'side', mainAtFork], repoCwd);
  const sideWtDir = path.join(tmpRoot, 'wt-side');
  git(['worktree', 'add', '-q', sideWtDir, 'side'], repoCwd);
  fs.writeFileSync(path.join(sideWtDir, 'f.txt'), 'from side\n', 'utf8');
  git(['add', '-A'], sideWtDir);
  git(['commit', '-q', '-m', 'side edits f.txt'], sideWtDir);
  git(['worktree', 'remove', '--force', sideWtDir], repoCwd);

  let rebaseExitCode = 0;
  try {
    git(['rebase', 'side'], wt2Dir);
  } catch (e) {
    rebaseExitCode = e.status;
  }
  expect(rebaseExitCode).not.toBe(0);

  const mainBefore = git(['rev-parse', 'main'], repoCwd).trim();
  const outcome = await gitWorktree.integrateBranch({
    cwd: repoCwd, branch: worktree.branch, key: slug, kind: 'job', allowRefLanding: true,
  });

  expect(outcome.ok).toBe(false);
  expect(outcome.failureKind).toBe('stray_checkout');
  expect(git(['rev-parse', 'main'], repoCwd).trim()).toBe(mainBefore);

  git(['rebase', '--abort'], wt2Dir);
  expect(git(['rev-parse', 'main'], repoCwd).trim()).toBe(mainBefore);

  git(['worktree', 'remove', '--force', wt2Dir], repoCwd);
  await gitWorktree.cleanupJobWorktree({ cwd: repoCwd, dir: worktree.dir, branch: worktree.branch, keepBranch: true });
  git(['branch', '-D', worktree.branch], repoCwd);
});

test('cwd itself mid-rebase (detached) refuses to land; main unchanged', async () => {
  const slug = 'ref-landing-cwd-mid-rebase';
  const worktree = await gitWorktree.createJobWorktree({ cwd: repoCwd, slug, fromRef: 'main' });
  fs.writeFileSync(path.join(worktree.dir, 'from-job-b.txt'), 'job output\n', 'utf8');
  git(['add', '-A'], worktree.dir);
  git(['commit', '-q', '-m', 'job commit'], worktree.dir);

  // repoCwd (still on main) and a sibling branch `side` — cut from the
  // commit before repoCwd's own new one — pick up conflicting edits to the
  // same file, so rebasing repoCwd's own checkout stops mid-conflict with
  // its OWN HEAD detached (not some other worktree's).
  const mainAtFork = git(['rev-parse', 'main'], repoCwd).trim();
  fs.writeFileSync(path.join(repoCwd, 'f.txt'), 'from main\n', 'utf8');
  git(['add', '-A'], repoCwd);
  git(['commit', '-q', '-m', 'main edits f.txt'], repoCwd);

  git(['branch', 'side', mainAtFork], repoCwd);
  const sideWtDir = path.join(tmpRoot, 'wt-side');
  git(['worktree', 'add', '-q', sideWtDir, 'side'], repoCwd);
  fs.writeFileSync(path.join(sideWtDir, 'f.txt'), 'from side\n', 'utf8');
  git(['add', '-A'], sideWtDir);
  git(['commit', '-q', '-m', 'side edits f.txt'], sideWtDir);
  git(['worktree', 'remove', '--force', sideWtDir], repoCwd);

  let rebaseExitCode = 0;
  try {
    git(['rebase', 'side'], repoCwd);
  } catch (e) {
    rebaseExitCode = e.status;
  }
  expect(rebaseExitCode).not.toBe(0);
  expect(await gitWorktree.getCurrentBranch(repoCwd)).toBe(null);

  const mainBefore = git(['rev-parse', 'main'], repoCwd).trim();
  const outcome = await gitWorktree.integrateBranch({
    cwd: repoCwd, branch: worktree.branch, key: slug, kind: 'job', allowRefLanding: true,
  });

  expect(outcome.ok).toBe(false);
  expect(outcome.failureKind).toBe('stray_checkout');
  expect(outcome.actualBranch).toBe('detached HEAD');
  expect(git(['rev-parse', 'main'], repoCwd).trim()).toBe(mainBefore);

  git(['rebase', '--abort'], repoCwd);
  await gitWorktree.cleanupJobWorktree({ cwd: repoCwd, dir: worktree.dir, branch: worktree.branch, keepBranch: true });
  git(['branch', '-D', worktree.branch], repoCwd);
});

test('cwd detached with no rebase in progress refuses to land; main unchanged', async () => {
  const slug = 'ref-landing-cwd-detached-plain';
  const worktree = await gitWorktree.createJobWorktree({ cwd: repoCwd, slug, fromRef: 'main' });
  fs.writeFileSync(path.join(worktree.dir, 'from-job-c.txt'), 'job output\n', 'utf8');
  git(['add', '-A'], worktree.dir);
  git(['commit', '-q', '-m', 'job commit'], worktree.dir);

  git(['checkout', '-q', '--detach', 'main'], repoCwd);
  const mainBefore = git(['rev-parse', 'main'], repoCwd).trim();
  expect(await gitWorktree.getCurrentBranch(repoCwd)).toBe(null);

  const outcome = await gitWorktree.integrateBranch({
    cwd: repoCwd, branch: worktree.branch, key: slug, kind: 'job', allowRefLanding: true,
  });

  expect(outcome.ok).toBe(false);
  expect(outcome.failureKind).toBe('stray_checkout');
  expect(outcome.actualBranch).toBe('detached HEAD');
  expect(git(['rev-parse', 'main'], repoCwd).trim()).toBe(mainBefore);

  await gitWorktree.cleanupJobWorktree({ cwd: repoCwd, dir: worktree.dir, branch: worktree.branch, keepBranch: true });
  git(['branch', '-D', worktree.branch], repoCwd);
});

test('carried-WIP-only branch refuses to land via ref, keeping the branch for recovery', async () => {
  const slug = 'ref-landing-carried-wip';
  const worktree = await gitWorktree.createJobWorktree({ cwd: repoCwd, slug, fromRef: 'main' });
  fs.writeFileSync(path.join(worktree.dir, 'carried.txt'), 'carried content\n', 'utf8');
  git(['add', '-A'], worktree.dir);
  git(['commit', '-q', '-m', 'job commit (carried path only)'], worktree.dir);

  git(['checkout', '-q', '-b', 'stray'], repoCwd);
  // Same path, same content, dirty on the wrong branch — there is no
  // trustworthy working tree here to content-verify against, which is
  // exactly why the ref path judges by path membership alone.
  fs.writeFileSync(path.join(repoCwd, 'carried.txt'), 'carried content\n', 'utf8');
  const mainBefore = git(['rev-parse', 'main'], repoCwd).trim();

  const outcome = await gitWorktree.integrateBranch({
    cwd: repoCwd, branch: worktree.branch, key: slug, kind: 'job', allowRefLanding: true,
    carriedPaths: ['carried.txt'],
  });

  expect(outcome.ok).toBe(false);
  expect(outcome.failureKind).toBe('stray_checkout');
  expect(git(['rev-parse', 'main'], repoCwd).trim()).toBe(mainBefore);
  expect(git(['branch', '--list', worktree.branch], repoCwd).trim()).not.toBe('');

  await gitWorktree.cleanupJobWorktree({ cwd: repoCwd, dir: worktree.dir, branch: worktree.branch, keepBranch: true });
  git(['branch', '-D', worktree.branch], repoCwd);
});

test('a non-fast-forward ref landing builds a real merge commit, parents in order [old main, branch head]', async () => {
  const slug = 'ref-landing-merge-commit';
  const worktree = await gitWorktree.createJobWorktree({ cwd: repoCwd, slug, fromRef: 'main' });
  fs.writeFileSync(path.join(worktree.dir, 'from-job-e.txt'), 'job output\n', 'utf8');
  git(['add', '-A'], worktree.dir);
  git(['commit', '-q', '-m', 'job commit'], worktree.dir);
  const branchHead = git(['rev-parse', worktree.branch], repoCwd).trim();

  git(['checkout', '-q', '-b', 'stray'], repoCwd);
  fs.writeFileSync(path.join(repoCwd, 'stray-wip.txt'), 'uncommitted work\n', 'utf8');
  const statusBefore = git(['status', '--porcelain'], repoCwd);

  // main advances on a DIFFERENT file via a temp worktree, never checking
  // main out in repoCwd — a real divergence, not just "behind."
  const wt2Dir = path.join(tmpRoot, 'wt2');
  git(['worktree', 'add', '-q', wt2Dir, 'main'], repoCwd);
  fs.writeFileSync(path.join(wt2Dir, 'other.txt'), 'from main\n', 'utf8');
  git(['add', '-A'], wt2Dir);
  git(['commit', '-q', '-m', 'main edits other.txt'], wt2Dir);
  git(['worktree', 'remove', '--force', wt2Dir], repoCwd);
  const mainNew = git(['rev-parse', 'main'], repoCwd).trim();

  const outcome = await gitWorktree.integrateBranch({
    cwd: repoCwd, branch: worktree.branch, key: slug, kind: 'job', allowRefLanding: true,
  });

  expect(outcome.ok).toBe(true);
  expect(outcome.integrated).toBe(true);
  expect(outcome.viaRef).toBe(true);
  expect(outcome.mergeCommit).toBe(true);
  const mainAfter = git(['rev-parse', 'main'], repoCwd).trim();
  expect(outcome.sha).toBe(mainAfter);
  expect(git(['log', '-1', '--format=%P', mainAfter], repoCwd).trim()).toBe(`${mainNew} ${branchHead}`);

  // The checkout never moved, and its uncommitted file is unchanged.
  expect(await gitWorktree.getCurrentBranch(repoCwd)).toBe('stray');
  expect(git(['status', '--porcelain'], repoCwd)).toBe(statusBefore);
  expect(fs.readFileSync(path.join(repoCwd, 'stray-wip.txt'), 'utf8')).toBe('uncommitted work\n');

  await gitWorktree.cleanupJobWorktree({ cwd: repoCwd, dir: worktree.dir, branch: worktree.branch });
});

test('cleanupJobWorktree called again with dir: undefined does not double-decrement the active count', async () => {
  const w1 = await gitWorktree.createJobWorktree({ cwd: repoCwd, slug: 'count-a' });
  const w2 = await gitWorktree.createJobWorktree({ cwd: repoCwd, slug: 'count-b' });
  expect(gitWorktree._getActiveWorktreeCountForTests('job')).toBe(2);

  await gitWorktree.cleanupJobWorktree({ cwd: repoCwd, dir: w1.dir, branch: w1.branch, keepBranch: true });
  expect(gitWorktree._getActiveWorktreeCountForTests('job')).toBe(1);

  // A later call for the SAME already-cleaned-up worktree, with no `dir` —
  // exactly what mechanical recovery does when it only wants to delete the
  // branch after the worktree dir was already freed earlier — must not
  // decrement the count a second time.
  await gitWorktree.cleanupJobWorktree({ cwd: repoCwd, dir: undefined, branch: w1.branch, keepBranch: false });
  expect(gitWorktree._getActiveWorktreeCountForTests('job')).toBe(1);

  await gitWorktree.cleanupJobWorktree({ cwd: repoCwd, dir: w2.dir, branch: w2.branch });
  expect(gitWorktree._getActiveWorktreeCountForTests('job')).toBe(0);
});

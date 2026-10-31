/**
 * gitWorktreeIntegrateSha.test.cjs — `integrateBranch`'s in-checkout success
 * returns carry `sha`, the commit that landed the job's own branch, so the
 * scheduler never has to infer it from repo-wide HEAD movement.
 *
 * Real throwaway repos under `os.tmpdir()`.
 *
 * Run: timeout 120 npx vitest run src/main/lib/__tests__/gitWorktreeIntegrateSha.test.cjs
 */

'use strict';

import { test, expect, beforeEach, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const gitWorktree = require('../git/gitWorktree.cjs');

let tmpRoot;
let repo;

function git(args, cwd = repo) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function commitFile(name, body, msg) {
  fs.writeFileSync(path.join(repo, name), body, 'utf8');
  git(['add', name]);
  git(['commit', '-q', '-m', msg]);
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'sm-integrate-sha-'));
  repo = path.join(tmpRoot, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);
  commitFile('README.md', 'hello\n', 'initial');
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function branchWithCommit(name, file) {
  git(['checkout', '-q', '-b', name]);
  commitFile(file, 'job\n', `job ${file}`);
  git(['checkout', '-q', 'main']);
}

test('fast-forward path returns sha === branch tip', async () => {
  branchWithCommit('sm-job/ff', 'ff.txt');
  const tip = git(['rev-parse', 'sm-job/ff']);
  const res = await gitWorktree.integrateBranch({ kind: 'job', cwd: repo, branch: 'sm-job/ff', mergeMessage: 'merge ff' });
  expect(res.ok).toBe(true);
  expect(res.fastForward).toBe(true);
  expect(res.sha).toBe(tip);
});

test('merge-commit path returns the new merge commit whose 2nd parent is the branch tip', async () => {
  branchWithCommit('sm-job/mc', 'mc.txt');
  const tip = git(['rev-parse', 'sm-job/mc']);
  commitFile('base-advance.txt', 'x\n', 'base advanced');
  const res = await gitWorktree.integrateBranch({ kind: 'job', cwd: repo, branch: 'sm-job/mc', mergeMessage: 'merge mc' });
  expect(res.ok).toBe(true);
  expect(res.mergeCommit).toBe(true);
  expect(res.sha).toBe(git(['rev-parse', 'HEAD']));
  expect(git(['rev-parse', `${res.sha}^2`])).toBe(tip);
});

test('no-new-commits path carries no sha', async () => {
  git(['branch', 'sm-job/none']);
  const res = await gitWorktree.integrateBranch({ kind: 'job', cwd: repo, branch: 'sm-job/none', mergeMessage: 'merge none' });
  expect(res.ok).toBe(true);
  expect(res.integrated).toBe(false);
  expect(res.sha).toBeUndefined();
});

test('commit-msg hook rejection on the merge commit yields hook_rejected and leaves no MERGE_HEAD', async () => {
  branchWithCommit('sm-job/hook', 'hook.txt');
  commitFile('base-advance.txt', 'x\n', 'base advanced');
  const hook = path.join(repo, '.git', 'hooks', 'commit-msg');
  fs.writeFileSync(hook, '#!/bin/sh\necho "identity-guard: commit blocked." >&2\nexit 1\n', { mode: 0o755 });
  const res = await gitWorktree.integrateBranch({ kind: 'job', cwd: repo, branch: 'sm-job/hook', mergeMessage: 'merge hook' });
  expect(res.ok).toBe(false);
  expect(res.failureKind).toBe('hook_rejected');
  expect(res.reason.startsWith('merge blocked by a git hook: ')).toBe(true);
  expect(fs.existsSync(path.join(repo, '.git', 'MERGE_HEAD'))).toBe(false);
});

test('mechanical recovery is futile for hook_rejected at an unchanged base HEAD', () => {
  const { selectMechanicalRecoveryTarget } = require('../../scheduler/reviewLadder.cjs');
  const job = {
    slug: 'x', status: 'needs_review', verifierVerdict: 'worktree_integration_failed',
    integrationFailureKind: 'hook_rejected', integrationBaseHeadSha: 'abc',
  };
  expect(selectMechanicalRecoveryTarget(job, 'abc')).toBeNull();
  expect(selectMechanicalRecoveryTarget(job, 'def')).not.toBeNull();
});

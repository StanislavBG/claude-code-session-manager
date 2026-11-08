/**
 * gitWorktreeForkSha.test.cjs — `createWorktree` pins its fork source to a SHA
 * and returns it as `forkSha`; `resolveForkSha` recovers a branch's fork commit
 * for rows that never recorded one (reflog creation entry). Integration needs
 * the fork point to replay only a job's own commits after the base branch is
 * rewritten while the job runs (Bilko 1716).
 *
 * Real git plumbing against throwaway repos under os.tmpdir().
 *
 * Run: timeout 120 npx vitest run src/main/lib/git/__tests__/gitWorktreeForkSha.test.cjs
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
let originalDisable;
let originalMax;

function git(args, cwd = repoCwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function commit(file, content, msg, cwd = repoCwd) {
  fs.writeFileSync(path.join(cwd, file), content, 'utf8');
  git(['add', '-A'], cwd);
  git(['commit', '-q', '-m', msg], cwd);
  return git(['rev-parse', 'HEAD'], cwd).trim();
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'sm-fork-sha-'));
  repoCwd = path.join(tmpRoot, 'repo');
  fs.mkdirSync(repoCwd, { recursive: true });
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);
  commit('a.txt', 'a\n', 'initial');
  originalDisable = process.env.SM_JOB_WORKTREE_DISABLE;
  originalMax = process.env.SM_JOB_WORKTREE_MAX;
  delete process.env.SM_JOB_WORKTREE_DISABLE;
  delete process.env.SM_JOB_WORKTREE_MAX;
  gitWorktree._resetActiveWorktreeCountForTests('job', 0);
});

afterEach(async () => {
  if (originalDisable === undefined) delete process.env.SM_JOB_WORKTREE_DISABLE;
  else process.env.SM_JOB_WORKTREE_DISABLE = originalDisable;
  if (originalMax === undefined) delete process.env.SM_JOB_WORKTREE_MAX;
  else process.env.SM_JOB_WORKTREE_MAX = originalMax;
  try { await gitWorktree.reconcileWorktreesOnBoot([repoCwd]); } catch { /* ignore */ }
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test('createWorktree (job) returns forkSha = base HEAD at creation, stable after the base moves', async () => {
  const headAtCreate = git(['rev-parse', 'HEAD']).trim();
  const r = await gitWorktree.createWorktree({ kind: 'job', cwd: repoCwd, key: 'fork-sha-create' });
  expect(r.ok).toBe(true);
  expect(r.forkSha).toBe(headAtCreate);
  expect(r.forkSha).toMatch(/^[0-9a-f]{40}$/);

  commit('b.txt', 'b\n', 'base moves on');
  commit('j.txt', 'j\n', 'job work', r.dir);
  expect(r.forkSha).toBe(headAtCreate);
  // is-ancestor exits 0 (no throw) when forkSha is an ancestor of the job branch.
  git(['merge-base', '--is-ancestor', r.forkSha, `refs/heads/${r.branch}`]);
  expect(await gitWorktree.resolveForkSha({ cwd: repoCwd, branch: r.branch, recorded: null })).toBe(headAtCreate);

  await gitWorktree.cleanupWorktree({ kind: 'job', cwd: repoCwd, dir: r.dir, branch: r.branch });
});

test('resolveForkSha returns recorded when it is an ancestor of the branch tip', async () => {
  const base = git(['rev-parse', 'HEAD']).trim();
  git(['branch', 'job']);
  git(['checkout', '-q', 'job']);
  const mid = commit('j1.txt', '1\n', 'job 1');
  commit('j2.txt', '2\n', 'job 2');
  git(['checkout', '-q', 'main']);
  expect(await gitWorktree.resolveForkSha({ cwd: repoCwd, branch: 'job', recorded: mid })).toBe(mid);
  expect(await gitWorktree.resolveForkSha({ cwd: repoCwd, branch: 'job', recorded: base })).toBe(base);
});

test('resolveForkSha falls back to the reflog creation SHA when recorded is null or not an ancestor', async () => {
  const base = git(['rev-parse', 'HEAD']).trim();
  git(['branch', 'job']);
  git(['checkout', '-q', 'job']);
  commit('j1.txt', '1\n', 'job 1');
  git(['checkout', '-q', 'main']);
  const offBranch = commit('m.txt', 'm\n', 'main only');
  expect(await gitWorktree.resolveForkSha({ cwd: repoCwd, branch: 'job', recorded: null })).toBe(base);
  expect(await gitWorktree.resolveForkSha({ cwd: repoCwd, branch: 'job', recorded: offBranch })).toBe(base);
  expect(await gitWorktree.resolveForkSha({ cwd: repoCwd, branch: 'job', recorded: 'not-a-ref' })).toBe(base);
});

test('resolveForkSha returns null for a missing branch (and never throws on odd names)', async () => {
  expect(await gitWorktree.resolveForkSha({ cwd: repoCwd, branch: 'no-such-branch', recorded: null })).toBeNull();
  expect(await gitWorktree.resolveForkSha({ cwd: repoCwd, branch: '--all', recorded: null })).toBeNull();
  expect(await gitWorktree.resolveForkSha({ cwd: repoCwd, branch: '', recorded: null })).toBeNull();
  expect(await gitWorktree.resolveForkSha({ cwd: path.join(tmpRoot, 'nope'), branch: 'main', recorded: null })).toBeNull();
});

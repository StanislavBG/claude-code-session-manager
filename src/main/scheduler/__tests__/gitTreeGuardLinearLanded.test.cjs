/**
 * gitTreeGuardLinearLanded.test.cjs — `isBranchAlreadyIntegrated`, the
 * reaper's proof that a dead job's `sm-job/<slug>` branch already landed.
 * Linear landing (PRDs 2743, 2825) replays a branch onto the base, so the
 * branch's own commits never become ancestors of HEAD, and an ancestry-only
 * check parks a landed job as "still holds unintegrated work — never merged"
 * (validator finding I-2). The linear-landed branch below is replayed with the
 * real `replayBranchOnto`, so the test sees the commits linear landing writes.
 *
 * Exercises real git plumbing against throwaway repos under os.tmpdir()
 * (fast — no network, no Electron).
 *
 * Run: timeout 120 npx vitest run src/main/scheduler/__tests__/gitTreeGuardLinearLanded.test.cjs
 */

'use strict';

import { test, expect, beforeEach, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const gitTreeGuard = require('../gitTreeGuard.cjs');
const gitWorktree = require('../../lib/git/gitWorktree.cjs');

const BRANCH = 'sm-job/2832-linear-landed';

let tmpRoot;
let repoCwd;

function git(args, cwd = repoCwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function commit(file, content, msg) {
  fs.writeFileSync(path.join(repoCwd, file), content, 'utf8');
  git(['add', '-A']);
  git(['commit', '-q', '-m', msg]);
  return git(['rev-parse', 'HEAD']).trim();
}

function isAncestor(a, b) {
  try {
    git(['merge-base', '--is-ancestor', a, b]);
    return true;
  } catch {
    return false;
  }
}

/** The job branch forks from main and commits job.txt; main then moves on. HEAD ends on main. */
function jobBranchThenMainMovesOn() {
  git(['checkout', '-q', '-b', BRANCH]);
  commit('job.txt', 'job work\n', 'feat(job): the job deliverable');
  git(['checkout', '-q', 'main']);
  commit('other.txt', 'main work\n', 'chore: main moves on');
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'sm-tree-guard-linear-'));
  repoCwd = path.join(tmpRoot, 'repo');
  fs.mkdirSync(repoCwd, { recursive: true });
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);
  commit('README.md', 'hello\n', 'initial');
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test('a branch landed as a linear replay -> true, though its tip is no ancestor of HEAD', async () => {
  jobBranchThenMainMovesOn();
  const r = await gitWorktree.replayBranchOnto({ cwd: repoCwd, ontoSha: git(['rev-parse', 'main']).trim(), branch: BRANCH });
  expect(r.ok).toBe(true);
  expect(r.replayed).toHaveLength(1);
  git(['merge', '-q', '--ff-only', r.tipSha]);

  expect(isAncestor(BRANCH, 'HEAD')).toBe(false);
  expect(await gitTreeGuard.isBranchAlreadyIntegrated(repoCwd, BRANCH)).toBe(true);
});

test('a branch merged by ancestry -> true (the fast path is unchanged)', async () => {
  jobBranchThenMainMovesOn();
  git(['merge', '-q', '--no-ff', '--no-edit', BRANCH]);

  expect(isAncestor(BRANCH, 'HEAD')).toBe(true);
  expect(await gitTreeGuard.isBranchAlreadyIntegrated(repoCwd, BRANCH)).toBe(true);
});

test('a branch still holding work HEAD never got -> false', async () => {
  jobBranchThenMainMovesOn();
  expect(await gitTreeGuard.isBranchAlreadyIntegrated(repoCwd, BRANCH)).toBe(false);
});

test('a branch that does not exist -> null (an in-place run, not a worktree run)', async () => {
  expect(await gitTreeGuard.isBranchAlreadyIntegrated(repoCwd, 'sm-job/never-existed')).toBeNull();
  expect(await gitTreeGuard.isBranchAlreadyIntegrated(repoCwd, '')).toBeNull();
});

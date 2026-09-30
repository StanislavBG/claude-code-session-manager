/**
 * jobLanding.test.cjs — PRD 8: `landJobBranch`/`promoteLandBranch` land a
 * scheduler job branch onto the per-Epic `sm-land/<epicId>` integration
 * branch checkout-free, then try to promote into the human's base branch
 * without ever failing the job on a promotion-only obstacle.
 *
 * Run: timeout 120 npx vitest run src/main/lib/__tests__/jobLanding.test.cjs
 */

'use strict';

import { test, expect, beforeEach, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const jobLanding = require('../jobLanding.cjs');
const gitWorktree = require('../gitWorktree.cjs');

let tmpRoot;
let repoCwd;

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function initRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  git(['init', '-q', '-b', 'main'], dir);
  git(['config', 'user.email', 'test@example.com'], dir);
  git(['config', 'user.name', 'Test'], dir);
  fs.writeFileSync(path.join(dir, 'file.txt'), 'base\n', 'utf8');
  git(['add', '-A'], dir);
  git(['commit', '-q', '-m', 'initial'], dir);
}

// Creates `branch` off current HEAD with one commit writing `content` to `file`.
function makeJobBranch(dir, branch, file, content) {
  git(['branch', branch], dir);
  git(['checkout', branch], dir);
  fs.writeFileSync(path.join(dir, file), content, 'utf8');
  git(['add', '-A'], dir);
  git(['commit', '-q', '-m', `job commit on ${branch}`], dir);
  git(['checkout', 'main'], dir);
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-joblanding-'));
  repoCwd = path.join(tmpRoot, 'repo');
  initRepo(repoCwd);
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test('(a) checkout on base, clean -> promoted, base has job commit', async () => {
  makeJobBranch(repoCwd, 'sm-job/one', 'a.txt', 'from job one\n');

  const result = await jobLanding.landJobBranch({
    cwd: repoCwd,
    branch: 'sm-job/one',
    slug: 'one',
    epicId: 'epic-a',
    baseBranch: 'main',
    carriedPaths: [],
  });

  expect(result.ok).toBe(true);
  expect(result.integrated).toBe(true);
  expect(result.promoted).toBe(true);
  expect(result.landedOn).toBe('sm-land/epic-a');
  expect(fs.readFileSync(path.join(repoCwd, 'a.txt'), 'utf8')).toBe('from job one\n');
  expect(await gitWorktree.getCurrentBranch(repoCwd)).toBe('main');
});

test('(b) checkout on feat/x -> base ref advanced checkout-free, feat/x untouched', async () => {
  git(['checkout', '-b', 'feat/x'], repoCwd);
  fs.writeFileSync(path.join(repoCwd, 'feat.txt'), 'feat wip\n', 'utf8');
  git(['add', '-A'], repoCwd);
  git(['commit', '-q', '-m', 'feat commit'], repoCwd);
  const featHeadBefore = git(['rev-parse', 'feat/x'], repoCwd).trim();

  git(['checkout', 'main'], repoCwd);
  makeJobBranch(repoCwd, 'sm-job/two', 'b.txt', 'from job two\n');
  git(['checkout', 'feat/x'], repoCwd);

  const result = await jobLanding.landJobBranch({
    cwd: repoCwd,
    branch: 'sm-job/two',
    slug: 'two',
    epicId: 'epic-b',
    baseBranch: 'main',
    carriedPaths: [],
  });

  expect(result.ok).toBe(true);
  expect(result.integrated).toBe(true);
  expect(result.promoted).toBe(true);
  expect(await gitWorktree.getCurrentBranch(repoCwd)).toBe('feat/x');
  expect(git(['rev-parse', 'feat/x'], repoCwd).trim()).toBe(featHeadBefore);
  expect(fs.existsSync(path.join(repoCwd, 'feat.txt'))).toBe(true);
  expect(fs.existsSync(path.join(repoCwd, 'b.txt'))).toBe(false);

  const mainLog = git(['log', 'main', '--name-only', '--pretty=format:%s'], repoCwd);
  expect(mainLog).toContain('b.txt');
});

test('(c) checkout on base with uncommitted edit to job-changed file -> landPending, dirty preserved', async () => {
  // The job branch's commit touches the SAME file (file.txt) the human's
  // checkout now has a differing uncommitted edit on, so the in-checkout
  // merge attempt refuses (would overwrite local changes) rather than
  // silently landing.
  makeJobBranch(repoCwd, 'sm-job/three', 'file.txt', 'from job three\n');
  fs.writeFileSync(path.join(repoCwd, 'file.txt'), 'human dirty edit\n', 'utf8');

  const result = await jobLanding.landJobBranch({
    cwd: repoCwd,
    branch: 'sm-job/three',
    slug: 'three',
    epicId: 'epic-c',
    baseBranch: 'main',
    carriedPaths: [],
  });

  expect(result.ok).toBe(true);
  expect(result.integrated).toBe(true);
  expect(result.promoted).toBe(false);
  expect(result.landPending).toBeTruthy();
  expect(result.landPending.branch).toBe('sm-land/epic-c');
  expect(fs.readFileSync(path.join(repoCwd, 'file.txt'), 'utf8')).toBe('human dirty edit\n');

  const landLog = git(['log', 'sm-land/epic-c'], repoCwd);
  expect(landLog).toContain('job commit on sm-job/three');
});

test('(d) two job branches conflicting on one line -> second ok:false content_conflict, sm-land unchanged', async () => {
  makeJobBranch(repoCwd, 'sm-job/four-a', 'file.txt', 'change A\n');
  makeJobBranch(repoCwd, 'sm-job/four-b', 'file.txt', 'change B\n');

  const first = await jobLanding.landJobBranch({
    cwd: repoCwd,
    branch: 'sm-job/four-a',
    slug: 'four-a',
    epicId: 'epic-d',
    baseBranch: 'main',
    carriedPaths: [],
  });
  expect(first.ok).toBe(true);

  const landShaBefore = git(['rev-parse', 'sm-land/epic-d'], repoCwd).trim();

  const second = await jobLanding.landJobBranch({
    cwd: repoCwd,
    branch: 'sm-job/four-b',
    slug: 'four-b',
    epicId: 'epic-d',
    baseBranch: 'main',
    carriedPaths: [],
  });

  expect(second.ok).toBe(false);
  expect(second.failureKind).toBe('content_conflict');
  expect(second.landedOn).toBe('sm-land/epic-d');
  expect(git(['rev-parse', 'sm-land/epic-d'], repoCwd).trim()).toBe(landShaBefore);
});

test('(e) no epicId -> legacy delegate to integrateJobBranch', async () => {
  makeJobBranch(repoCwd, 'sm-job/five', 'e.txt', 'from job five\n');

  const result = await jobLanding.landJobBranch({
    cwd: repoCwd,
    branch: 'sm-job/five',
    slug: 'five',
    baseBranch: 'main',
    carriedPaths: [],
  });

  expect(result.ok).toBe(true);
  expect(result.integrated).toBe(true);
  expect(fs.readFileSync(path.join(repoCwd, 'e.txt'), 'utf8')).toBe('from job five\n');
  expect(result.promoted).toBeUndefined();
  expect(result.landedOn).toBeUndefined();
});

test('(f) carried-wip-only skip', async () => {
  // file.txt is "carried" base-tree WIP: the job branch's only commit
  // re-commits that exact same content, so it must be classified as
  // carried-wip-only and skipped rather than merged.
  git(['branch', 'sm-job/six'], repoCwd);
  git(['checkout', 'sm-job/six'], repoCwd);
  fs.writeFileSync(path.join(repoCwd, 'file.txt'), 'carried content\n', 'utf8');
  git(['add', '-A'], repoCwd);
  git(['commit', '-q', '-m', 'recommit carried wip'], repoCwd);
  git(['checkout', 'main'], repoCwd);
  fs.writeFileSync(path.join(repoCwd, 'file.txt'), 'carried content\n', 'utf8');

  const result = await jobLanding.landJobBranch({
    cwd: repoCwd,
    branch: 'sm-job/six',
    slug: 'six',
    epicId: 'epic-f',
    baseBranch: 'main',
    carriedPaths: ['file.txt'],
  });

  expect(result).toEqual({ ok: true, integrated: false, reason: 'carried-wip-only' });
});

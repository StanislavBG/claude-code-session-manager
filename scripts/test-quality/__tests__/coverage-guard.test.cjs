/**
 * coverage-guard.test.cjs — end-to-end: the real CLI against commits made in a
 * detached temp worktree of HEAD.
 *
 * Fixture module: src/renderer/lib/compactPath.ts. It is the single
 * coverer-by-name: only src/renderer/lib/__tests__/compactPath.test.ts
 * mentions "compactPath" among test files (verified by grep).
 *
 * Run: timeout 400 npx vitest run scripts/test-quality/__tests__/coverage-guard.test.cjs
 */

'use strict';

import { test, expect, beforeAll, afterAll } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '../../..');
const CLI = path.join(REPO_ROOT, 'scripts/test-quality/coverage-guard.cjs');
const SRC = 'src/renderer/lib/compactPath.ts';
const TEST = 'src/renderer/lib/__tests__/compactPath.test.ts';

const git = (cwd, ...args) =>
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
    cwd,
    encoding: 'utf8',
  });

let tmp;
let wt;
let startSha;

function nodeModulesOf(root) {
  const local = path.join(root, 'node_modules');
  if (fs.existsSync(local)) return local;
  const common = path.resolve(root, git(root, 'rev-parse', '--git-common-dir').trim());
  return path.join(path.dirname(common), 'node_modules');
}

function runGuard() {
  const env = { ...process.env };
  for (const k of ['VITEST', 'VITEST_POOL_ID', 'VITEST_WORKER_ID', 'VITEST_MODE']) delete env[k];
  return spawnSync('node', [CLI, '--base', 'HEAD~1'], { cwd: wt, env, encoding: 'utf8' });
}

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cov-guard-test-'));
  wt = path.join(tmp, 'wt');
  git(REPO_ROOT, 'worktree', 'add', '--detach', wt, 'HEAD');
  fs.symlinkSync(nodeModulesOf(REPO_ROOT), path.join(wt, 'node_modules'), 'dir');
  startSha = git(wt, 'rev-parse', 'HEAD').trim();
}, 300000);

afterAll(() => {
  try {
    git(REPO_ROOT, 'worktree', 'remove', '--force', wt);
  } catch {
    /* already gone */
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  git(REPO_ROOT, 'worktree', 'prune');
}, 60000);

function commitFrom(mutate, msg) {
  git(wt, 'reset', '--hard', startSha);
  mutate();
  git(wt, 'add', '-A', '--', 'src');
  git(wt, 'commit', '-m', msg);
}

test('deleting the only covering test fails the guard and names the module', () => {
  commitFrom(() => git(wt, 'rm', TEST), 'delete test');
  const r = runGuard();
  expect(r.status).toBe(1);
  expect(r.stdout).toContain(SRC);
  expect(r.stdout).toMatch(/coverage-guard: DROPPED \d+ keys/);
}, 300000);

test('renaming the test with identical content passes', () => {
  commitFrom(
    () => git(wt, 'mv', TEST, TEST.replace('compactPath.test', 'compactPathRenamed.test')),
    'rename test',
  );
  const r = runGuard();
  expect(r.stdout).toMatch(/coverage-guard: OK \d+ src files, 0 dropped/);
  expect(r.status).toBe(0);
}, 300000);

test('a commit that edits a src file exits 2', () => {
  commitFrom(() => fs.appendFileSync(path.join(wt, SRC), '\n// touched\n'), 'edit src');
  const r = runGuard();
  expect(r.status).toBe(2);
  expect(r.stderr).toContain('coverage-guard: needs a test-only diff');
  expect(r.stderr).toContain(SRC);
}, 300000);

/**
 * ephemeralCwd.test.cjs — isEphemeralCwd(cwd) must refuse a cwd that
 * resolves to os.tmpdir() itself, into a managed worktree root, or onto a
 * linked git worktree's own root — and must allow an ordinary project cwd.
 *
 * See ephemeralCwd.cjs's header for the live incident (2026-09-01) this
 * predicate closes: queueStore.writeSplit materializing scheduler state
 * inside an ephemeral epic worktree, torn down with the Epic and silently
 * losing the write.
 *
 * Run: timeout 120 npx vitest run src/main/lib/__tests__/ephemeralCwd.test.cjs
 */

'use strict';

import { test, expect, afterEach } from 'vitest';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { isEphemeralCwd } = require('../ephemeralCwd.cjs');
const { KIND_CONFIG } = require('../gitWorktree.cjs');

const tmpDirs = [];

afterEach(async () => {
  while (tmpDirs.length) {
    await fsp.rm(tmpDirs.pop(), { recursive: true, force: true }).catch(() => {});
  }
});

// A real project must never itself live under /tmp — only ephemeral fixtures
// (worktree checkouts) do. `test-results/` is already gitignored.
const NON_TMP_SCRATCH_ROOT = path.join(process.cwd(), 'test-results', 'ephemeral-cwd-fixtures');

async function mkNonTmpDir(prefix) {
  fs.mkdirSync(NON_TMP_SCRATCH_ROOT, { recursive: true });
  return fsp.mkdtemp(path.join(NON_TMP_SCRATCH_ROOT, prefix));
}

async function makeWorktreeFixture() {
  const main = await mkNonTmpDir('sm-ephemeral-main-');
  tmpDirs.push(main);
  fs.mkdirSync(path.join(main, '.git'), { recursive: true });
  const worktree = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-ephemeral-worktree-'));
  tmpDirs.push(worktree);
  const worktreeName = 'sm-epic-abc123';
  const worktreeGitFile = path.join(worktree, '.git');
  const adminDir = path.join(main, '.git', 'worktrees', worktreeName);
  fs.mkdirSync(adminDir, { recursive: true });
  fs.writeFileSync(path.join(adminDir, 'gitdir'), `${worktreeGitFile}\n`, 'utf8');
  fs.writeFileSync(worktreeGitFile, `gitdir: ${adminDir}\n`, 'utf8');
  return { main, worktree };
}

test('isEphemeralCwd refuses os.tmpdir() itself', () => {
  expect(isEphemeralCwd(os.tmpdir())).toBe(true);
});

test('isEphemeralCwd refuses a cwd under the managed epic worktree root', () => {
  const cwd = path.join(KIND_CONFIG.epic.root, 'some-hash', 'some-epic-slug');
  expect(isEphemeralCwd(cwd)).toBe(true);
});

test('isEphemeralCwd refuses a cwd under the managed job worktree root', () => {
  const cwd = path.join(KIND_CONFIG.job.root, 'some-job-id');
  expect(isEphemeralCwd(cwd)).toBe(true);
});

test('isEphemeralCwd refuses a linked git worktree root anywhere on disk', async () => {
  const { worktree } = await makeWorktreeFixture();
  expect(isEphemeralCwd(worktree)).toBe(true);
});

test('isEphemeralCwd allows an ordinary project cwd (the worktree fixture\'s own main tree)', async () => {
  const { main } = await makeWorktreeFixture();
  expect(isEphemeralCwd(main)).toBe(false);
});

test('isEphemeralCwd allows an ordinary tmpdir-adjacent fixture used by other test suites (not os.tmpdir() itself, not a managed worktree root, not a linked worktree)', async () => {
  const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-some-other-test-fixture-'));
  tmpDirs.push(cwd);
  expect(isEphemeralCwd(cwd)).toBe(false);
});

test('isEphemeralCwd is false for non-absolute or missing input, never throws', () => {
  expect(isEphemeralCwd('relative/path')).toBe(false);
  expect(isEphemeralCwd('')).toBe(false);
  expect(isEphemeralCwd(null)).toBe(false);
  expect(isEphemeralCwd(undefined)).toBe(false);
});

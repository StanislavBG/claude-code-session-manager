/**
 * gitExec.test.cjs — the shared `execGit`/`parseWorktreePorcelain` helper
 * consolidated out of gitWorktree.cjs/branchSweep.cjs/scheduler.cjs's three
 * near-duplicate implementations.
 *
 * Run: timeout 120 npx vitest run src/main/lib/__tests__/gitExec.test.cjs
 */
'use strict';

import { test, expect, beforeEach, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execGit, parseWorktreePorcelain } = require('../gitExec.cjs');

let tmpRoot;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-gitexec-'));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test('execGit runs real git in the given cwd and resolves with stdout', async () => {
  const out = await execGit(tmpRoot, ['--version']);
  expect(out).toMatch(/git version/);
});

test('execGit rejects with stderrText/stdoutText on a real git failure', async () => {
  await expect(execGit(tmpRoot, ['not-a-real-subcommand'])).rejects.toMatchObject({
    stderrText: expect.any(String),
  });
});

test('execGit never shells out through a string — argv array only', async () => {
  // A path with a space and a shell metacharacter would break on a naive
  // shell-string implementation; execFile with an argv array passes it
  // through untouched as a single argument.
  const weird = path.join(tmpRoot, 'a b; echo pwned');
  fs.mkdirSync(weird);
  const out = await execGit(weird, ['rev-parse', '--is-inside-work-tree']).catch((e) => e.stderrText || '');
  // Not a git repo, so this fails — the point is it fails on git's own
  // "not a git repository" error, not a shell syntax error from `;`.
  expect(out).toMatch(/not a git repository/i);
});

test('execGit respects a short timeout', async () => {
  await expect(execGit(tmpRoot, ['--version'], { timeout: 1 })).rejects.toBeTruthy();
});

test('parseWorktreePorcelain parses a simple single-worktree listing', () => {
  const fixture = [
    'worktree /tmp/repo',
    'HEAD abc123',
    'branch refs/heads/main',
    '',
  ].join('\n');
  expect(parseWorktreePorcelain(fixture)).toEqual([{ worktree: '/tmp/repo', branch: 'main' }]);
});

test('parseWorktreePorcelain parses multiple worktree entries', () => {
  const fixture = [
    'worktree /tmp/repo',
    'HEAD abc123',
    'branch refs/heads/main',
    '',
    'worktree /tmp/wt1',
    'HEAD def456',
    'branch refs/heads/sm-job/foo',
    '',
  ].join('\n');
  expect(parseWorktreePorcelain(fixture)).toEqual([
    { worktree: '/tmp/repo', branch: 'main' },
    { worktree: '/tmp/wt1', branch: 'sm-job/foo' },
  ]);
});

test('parseWorktreePorcelain leaves branch null for a detached worktree', () => {
  const fixture = ['worktree /tmp/repo', 'HEAD abc123', 'detached', ''].join('\n');
  expect(parseWorktreePorcelain(fixture)).toEqual([{ worktree: '/tmp/repo', branch: null }]);
});

test('parseWorktreePorcelain returns [] for empty/garbage input', () => {
  expect(parseWorktreePorcelain('')).toEqual([]);
  expect(parseWorktreePorcelain(null)).toEqual([]);
  expect(parseWorktreePorcelain('nonsense\nmore nonsense')).toEqual([]);
});

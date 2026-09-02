/**
 * guard-destructive-git.test.cjs — PreToolUse hook contract tests for
 * scripts/hooks/guard-destructive-git.cjs. Runs the real script as a child
 * process (stdin JSON in, stdout JSON out), same as guard-prd-writes.test.cjs,
 * so the test exercises the actual install shape.
 *
 * Run: timeout 60 npx vitest run scripts/hooks/__tests__/guard-destructive-git.test.cjs
 */

'use strict';

import { test, expect } from 'vitest';
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const HOOK_PATH = path.join(__dirname, '..', 'guard-destructive-git.cjs');
const SHARED_CWD = '/home/tester/Projects/some-repo';
const JOB_WORKTREE_CWD = path.join(os.tmpdir(), 'session-manager-job-worktrees', 'abc123', 'some-slug');
const EPIC_WORKTREE_CWD = path.join(os.tmpdir(), 'session-manager-epic-worktrees', 'def456', 'some-epic-id');

function runHook(payload) {
  const input = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const result = spawnSync(process.execPath, [HOOK_PATH], {
    input,
    encoding: 'utf8',
    timeout: 10_000,
  });
  let parsed = null;
  try {
    parsed = result.stdout ? JSON.parse(result.stdout) : null;
  } catch { /* asserted separately per test */ }
  return { ...result, parsed };
}

function runBash(command, cwd = SHARED_CWD) {
  return runHook({ tool_name: 'Bash', cwd, tool_input: { command } });
}

function expectDenied(command, cwd = SHARED_CWD) {
  const { parsed, status } = runBash(command, cwd);
  expect(status).toBe(0);
  expect(parsed?.hookSpecificOutput?.permissionDecision).toBe('deny');
  return parsed;
}

function expectAllowed(command, cwd = SHARED_CWD) {
  const { parsed, status } = runBash(command, cwd);
  expect(status).toBe(0);
  expect(parsed?.hookSpecificOutput?.permissionDecision).not.toBe('deny');
  return parsed;
}

// ─────────────────────────────── deny matrix (shared tree)

test('denies git stash (bare form)', () => {
  const parsed = expectDenied('git stash');
  expect(parsed.reason).toMatch(/git stash/);
});

test('denies git stash push', () => {
  expectDenied('git stash push -m "wip"');
});

test('denies git stash pop', () => {
  expectDenied('git stash pop');
});

test('denies git reset --hard', () => {
  const parsed = expectDenied('git reset --hard HEAD~1');
  expect(parsed.reason).toMatch(/git reset --hard/);
});

test('denies git reset with a path', () => {
  expectDenied('git reset src/index.js');
});

test('denies git checkout -- <path>', () => {
  const parsed = expectDenied('git checkout -- src/index.js');
  expect(parsed.reason).toMatch(/git checkout -- <path>/);
});

test('denies git restore against a tracked path', () => {
  expectDenied('git restore src/index.js');
});

test('denies bare git checkout . (no --)', () => {
  const parsed = expectDenied('git checkout .');
  expect(parsed.reason).toMatch(/git checkout \./);
});

test('denies git checkout -f .', () => {
  expectDenied('git checkout -f .');
});

test('denies git clean -fd', () => {
  const parsed = expectDenied('git clean -fd');
  expect(parsed.reason).toMatch(/git clean/);
});

test('denies git clean -f -x', () => {
  expectDenied('git clean -f -x');
});

test('denies git add -A', () => {
  const parsed = expectDenied('git add -A');
  expect(parsed.reason).toMatch(/git add/);
});

test('denies git add .', () => {
  expectDenied('git add .');
});

test('denies bare git commit -a', () => {
  const parsed = expectDenied('git commit -a -m "wip"');
  expect(parsed.reason).toMatch(/git commit -a/);
});

test('denies git commit -am (combined short flags)', () => {
  expectDenied('git commit -am "wip"');
});

// ─────────────────────────────── allow matrix (read-only / scoped)

test('allows git status', () => { expectAllowed('git status'); });
test('allows git diff', () => { expectAllowed('git diff'); });
test('allows git log', () => { expectAllowed('git log -5'); });
test('allows git show', () => { expectAllowed('git show HEAD'); });
test('allows git stash list', () => { expectAllowed('git stash list'); });
test('allows git stash show', () => { expectAllowed('git stash show -p'); });
test('allows git rev-parse', () => { expectAllowed('git rev-parse --git-common-dir'); });
test('allows git add with an explicit path', () => { expectAllowed('git add src/index.js src/other.js'); });
test('allows git commit -m with staged explicit paths', () => { expectAllowed('git commit -m "feat: x"'); });
test('allows git reset with no args', () => { expectAllowed('git reset'); });
test('allows git checkout of a branch (no --)', () => { expectAllowed('git checkout main'); });
test('allows git clean -n (dry run) even with -f', () => { expectAllowed('git clean -nf'); });

// ─────────────────────────────── shared-tree vs. managed-worktree scoping

test('permits git stash inside an sm-job/ worktree path', () => {
  expectAllowed('git stash', JOB_WORKTREE_CWD);
});

test('permits git reset --hard inside an sm-epic/ worktree path', () => {
  expectAllowed('git reset --hard', EPIC_WORKTREE_CWD);
});

test('denies the same command one level outside the managed worktree root', () => {
  expectDenied('git stash', path.join(os.tmpdir(), 'not-a-managed-worktree'));
});

// ─────────────────────────────── robustness: the shapes the guard must not miss

test('denies with a leading env assignment', () => {
  expectDenied('FOO=bar git stash');
});

test('denies with git -C <dir>', () => {
  expectDenied(`git -C ${SHARED_CWD} stash`);
});

test('denies when chained with &&', () => {
  expectDenied('npm test && git reset --hard');
});

test('denies when chained with ;', () => {
  expectDenied('echo hi; git clean -fd');
});

test('denies when chained with |', () => {
  expectDenied('echo y | git stash');
});

test('denies across a newline', () => {
  expectDenied('npm test\ngit checkout -- src/index.js');
});

test('denies inside an sh -c wrapper', () => {
  expectDenied(`sh -c 'git stash'`);
});

test('denies inside a bash -c wrapper chained with other commands', () => {
  expectDenied(`bash -c 'cd /tmp && git reset --hard'`);
});

test('allows a chain with no destructive git command at all', () => {
  expectAllowed('npm test && git status && echo done');
});

// ─────────────────────────────── fail-closed on ambiguous parsing

test('fails closed (denies) on an unterminated quote mentioning git', () => {
  expectDenied(`git commit -m "unterminated`);
});

test('does not fail closed on an unterminated quote with no git mention', () => {
  expectAllowed(`echo "unterminated`);
});

// ─────────────────────────────── non-Bash / malformed payloads never block

test('allows non-Bash tool calls untouched', () => {
  const { parsed } = runHook({ tool_name: 'Write', cwd: SHARED_CWD, tool_input: { file_path: 'x.md', content: 'x' } });
  expect(parsed?.hookSpecificOutput?.permissionDecision).not.toBe('deny');
});

test('fails open on malformed stdin JSON', () => {
  const { status, parsed } = runHook('{ not valid json');
  expect(status).toBe(0);
  expect(parsed?.hookSpecificOutput?.permissionDecision).not.toBe('deny');
});

test('fails open when tool_input.command is missing', () => {
  const { parsed } = runHook({ tool_name: 'Bash', cwd: SHARED_CWD, tool_input: {} });
  expect(parsed?.hookSpecificOutput?.permissionDecision).not.toBe('deny');
});

/**
 * guard-destructive-git.test.cjs — PreToolUse hook contract tests for
 * scripts/hooks/guard-destructive-git.cjs.
 *
 * Exercises `decide()`/`parsePayload()` from
 * scripts/hooks/lib/guard-destructive-git-policy.cjs — the decision logic
 * the CLI wraps — in-process for every policy case. Requiring that module
 * has no I/O of its own, so requiring it directly is equivalent to the real
 * decision the CLI makes, just without paying for a *CLI* child-process
 * spawn per case. (The CLI file itself can't be safely `require()`d from a
 * test: it runs its stdin-read-then-process.exit main() as a require-time
 * side effect — deliberately, see its header — which would hang/kill the
 * test process.) Note `decide()` itself still shells out to a real `git
 * rev-parse` for most denied cases outside a path-recognized managed
 * worktree (see `isInsideManagedWorktreeByBranch` in the policy module) —
 * this removes the outer CLI-process spawn, not every subprocess spawn.
 *
 * Only ONE test (the "smoke test" section at the bottom) spawns the real CLI
 * script as a child process, to prove the actual install shape (stdin JSON
 * in, stdout JSON out, per guard-destructive-git.cjs's header) still works.
 * Root cause of the prior flake (PRD 1412): this file used to spawn the real
 * CLI process ~50 times per run; under full-suite parallel-worker load, one
 * spawn could occasionally miss its hardcoded 10s timeout and get
 * SIGTERM-killed, failing that test's `expect(status).toBe(0)` — an infra
 * timing flake, not a parsing bug (the parser itself is fully deterministic:
 * no shared/global state *in the parsing logic*, no randomness, and a fresh
 * process each call can't accumulate cross-test skew). Running the same 50
 * cases in-process removes ~49 of those outer CLI-process spawns.
 *
 * Run: timeout 60 npx vitest run scripts/hooks/__tests__/guard-destructive-git.test.cjs
 */

'use strict';

import { test, expect } from 'vitest';
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { decide, parsePayload } = require('../lib/guard-destructive-git-policy.cjs');

const HOOK_PATH = path.join(__dirname, '..', 'guard-destructive-git.cjs');
const SHARED_CWD = '/home/tester/Projects/some-repo';
const JOB_WORKTREE_CWD = path.join(process.env.SM_WORKTREE_ROOT || os.tmpdir(), 'session-manager-job-worktrees', 'abc123', 'some-slug');
const EPIC_WORKTREE_CWD = path.join(process.env.SM_WORKTREE_ROOT || os.tmpdir(), 'session-manager-epic-worktrees', 'def456', 'some-epic-id');

function runBash(command, cwd = SHARED_CWD) {
  return decide({ tool_name: 'Bash', cwd, tool_input: { command } });
}

function expectDenied(command, cwd = SHARED_CWD) {
  const parsed = runBash(command, cwd);
  expect(parsed?.hookSpecificOutput?.permissionDecision).toBe('deny');
  return parsed;
}

function expectAllowed(command, cwd = SHARED_CWD) {
  const parsed = runBash(command, cwd);
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

test('fails closed (denies) on an unterminated quote mentioning a policed verb (git stash)', () => {
  expectDenied(`git stash -m "unterminated`);
});

test('does not fail closed on an unterminated quote with no git mention', () => {
  expectAllowed(`echo "unterminated`);
});

test('does not fail closed on an unterminated quote mentioning git but no policed verb (plain commit -m)', () => {
  // Narrowed per PRD 1106: `git commit -m` alone is never destructive (only
  // `git commit -a`/`--all` is policed), so an unparsable command that merely
  // mentions "git commit" must not be blanket-blocked — a real incident
  // (a heredoc `git commit -m "$(cat <<'EOF' ... EOF)"`) was killed by the
  // old blanket rule.
  expectAllowed(`git commit -m "unterminated`);
});

// ─────────────────────────────── non-Bash / malformed payloads never block

test('allows non-Bash tool calls untouched', () => {
  const parsed = decide({ tool_name: 'Write', cwd: SHARED_CWD, tool_input: { file_path: 'x.md', content: 'x' } });
  expect(parsed?.hookSpecificOutput?.permissionDecision).not.toBe('deny');
});

test('fails open on malformed stdin JSON', () => {
  const parsed = decide(parsePayload('{ not valid json'));
  expect(parsed?.hookSpecificOutput?.permissionDecision).not.toBe('deny');
});

test('fails open when tool_input.command is missing', () => {
  const parsed = decide({ tool_name: 'Bash', cwd: SHARED_CWD, tool_input: {} });
  expect(parsed?.hookSpecificOutput?.permissionDecision).not.toBe('deny');
});

// ─────────────────────────────── effective-cwd resolution (PRD 1106)

test('allows `cd <sm-job worktree> && git stash` from a shared-tree payload.cwd', () => {
  expectAllowed(`cd ${JOB_WORKTREE_CWD} && git stash`, SHARED_CWD);
});

test('allows `git -C <sm-job worktree> <destructive op>` from a shared-tree payload.cwd', () => {
  expectAllowed(`git -C ${JOB_WORKTREE_CWD} reset --hard HEAD~1`, SHARED_CWD);
});

test('still denies the same destructive command with no cd prefix on a shared-tree cwd (no regression)', () => {
  expectDenied('git stash', SHARED_CWD);
});

test('allows a heredoc git commit -m "$(cat <<\'EOF\' ... EOF)"', () => {
  const command = 'git commit -m "$(cat <<\'EOF\'\nsome commit body\nEOF\n)"';
  expectAllowed(command);
});

test('denies an unparsable command containing git stash', () => {
  expectDenied(`git stash push -m "unterminated`);
});

// ─────────────────────────────── smoke test: real process wiring
//
// The only test in this file that spawns the actual script as a child
// process — proves the CLI shape guard-destructive-git.cjs's header
// documents (stdin JSON in, stdout JSON out) still works end-to-end, the
// same case ('denies across a newline') that originally flaked in PRD 1412.
// Generous timeout + maxBuffer since this is now a single spawn, not ~50.

test('smoke: real process wiring denies across a newline (stdin JSON in, stdout JSON out)', () => {
  const result = spawnSync(process.execPath, [HOOK_PATH], {
    input: JSON.stringify({
      tool_name: 'Bash',
      cwd: SHARED_CWD,
      tool_input: { command: 'npm test\ngit checkout -- src/index.js' },
    }),
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 10 * 1024 * 1024,
  });
  expect(result.status).toBe(0);
  const parsed = JSON.parse(result.stdout);
  expect(parsed?.hookSpecificOutput?.permissionDecision).toBe('deny');
  expect(parsed.reason).toMatch(/git checkout -- <path>/);
});

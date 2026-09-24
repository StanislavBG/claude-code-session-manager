/**
 * guard-inline-implementation.test.cjs — PreToolUse hook contract tests for
 * scripts/hooks/guard-inline-implementation.cjs.
 *
 * Exercises `decide()`/`parsePayload()` from
 * scripts/hooks/lib/guard-inline-implementation-policy.cjs — the decision
 * logic the CLI wraps — in-process for every policy case, against a real tmp
 * "project" directory so the active-index.json lookup (and, for one case, a
 * real git worktree) still exercises real filesystem/git behavior. Requiring
 * that module directly is equivalent to the real decision the CLI makes,
 * just without paying for a CLI child-process spawn per case. (The CLI file
 * itself can't be safely `require()`d from a test: it runs its
 * stdin-read-then-process.exit main() as a require-time side effect —
 * deliberately, see its header — which would hang/kill the test process.)
 *
 * Same class of fix as guard-destructive-git.test.cjs (PRD 1412): this file
 * used to spawn the real CLI process once per case (10 spawns, one of which
 * itself spawns 3 more `git` child processes for the worktree-resolution
 * case) with a shared `timeout: 10_000` — same mechanism that flaked under
 * full-suite parallel-worker load, just fewer spawns. Only ONE test (the
 * "smoke test" section at the bottom) still spawns the real CLI script as a
 * child process, to prove the actual install shape (stdin JSON in, stdout
 * JSON out) works.
 *
 * Run: timeout 60 npx vitest run scripts/hooks/__tests__/guard-inline-implementation.test.cjs
 */

'use strict';

import { test, expect, beforeEach, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { decide, parsePayload } = require('../lib/guard-inline-implementation-policy.cjs');

const HOOK_PATH = path.join(__dirname, '..', 'guard-inline-implementation.cjs');

let projectDir;

beforeEach(() => {
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-guard-inline-'));
});

afterEach(() => {
  fs.rmSync(projectDir, { recursive: true, force: true });
});

function writeIndex(sessions) {
  const dir = path.join(projectDir, 'session-manager-operations', 'prompt-sessions');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'active-index.json'),
    JSON.stringify({ sessions, events: [], tombstones: [] }),
  );
}

/** Runs `decide()` in-process with `env` vars set for the duration of the call, then restored. */
function decideWithEnv(payload, env) {
  const keys = env ? Object.keys(env) : [];
  const prev = {};
  for (const k of keys) prev[k] = process.env[k];
  for (const k of keys) process.env[k] = env[k];
  try {
    return decide(payload);
  } finally {
    for (const k of keys) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  }
}

test('denies a Write to application source in a feature Epic', () => {
  writeIndex({
    'epic-1': { id: 'epic-1', claudeSessionId: 'sess-feature', tag: 'feature' },
  });
  const parsed = decide({
    session_id: 'sess-feature',
    tool_name: 'Write',
    cwd: projectDir,
    tool_input: { file_path: `${projectDir}/src/main/foo.cjs`, content: 'x' },
  });
  expect(parsed.hookSpecificOutput.permissionDecision).toBe('deny');
  expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain('/develop');
});

test('denies an Edit to application source in a bug Epic', () => {
  writeIndex({
    'epic-1': { id: 'epic-1', claudeSessionId: 'sess-bug', tag: 'bug' },
  });
  const parsed = decide({
    session_id: 'sess-bug',
    tool_name: 'Edit',
    cwd: projectDir,
    tool_input: { file_path: `${projectDir}/scripts/build.cjs`, old_string: 'a', new_string: 'b' },
  });
  expect(parsed.hookSpecificOutput.permissionDecision).toBe('deny');
});

test('allows a Write to application source in a discussion Epic', () => {
  writeIndex({
    'epic-1': { id: 'epic-1', claudeSessionId: 'sess-discuss', tag: 'discussion' },
  });
  const parsed = decide({
    session_id: 'sess-discuss',
    tool_name: 'Write',
    cwd: projectDir,
    tool_input: { file_path: `${projectDir}/src/main/foo.cjs`, content: 'x' },
  });
  expect(parsed).toEqual({ continue: true });
});

test('allows with the SM_ALLOW_INLINE_IMPLEMENTATION env escape hatch', () => {
  writeIndex({
    'epic-1': { id: 'epic-1', claudeSessionId: 'sess-feature', tag: 'feature' },
  });
  const parsed = decideWithEnv(
    {
      session_id: 'sess-feature',
      tool_name: 'Write',
      cwd: projectDir,
      tool_input: { file_path: `${projectDir}/src/main/foo.cjs`, content: 'x' },
    },
    { SM_ALLOW_INLINE_IMPLEMENTATION: '1' },
  );
  expect(parsed).toEqual({ continue: true });
});

test('allows with the per-Epic allowInlineImplementation flag', () => {
  writeIndex({
    'epic-1': { id: 'epic-1', claudeSessionId: 'sess-feature', tag: 'feature', allowInlineImplementation: true },
  });
  const parsed = decide({
    session_id: 'sess-feature',
    tool_name: 'Write',
    cwd: projectDir,
    tool_input: { file_path: `${projectDir}/src/main/foo.cjs`, content: 'x' },
  });
  expect(parsed).toEqual({ continue: true });
});

test('allows on an unresolvable session id', () => {
  writeIndex({
    'epic-1': { id: 'epic-1', claudeSessionId: 'sess-feature', tag: 'feature' },
  });
  const parsed = decide({
    session_id: 'sess-unknown',
    tool_name: 'Write',
    cwd: projectDir,
    tool_input: { file_path: `${projectDir}/src/main/foo.cjs`, content: 'x' },
  });
  expect(parsed).toEqual({ continue: true });
});

test('allows a path under session-manager-operations/ even in a feature Epic', () => {
  writeIndex({
    'epic-1': { id: 'epic-1', claudeSessionId: 'sess-feature', tag: 'feature' },
  });
  const parsed = decide({
    session_id: 'sess-feature',
    tool_name: 'Write',
    cwd: projectDir,
    tool_input: { file_path: `${projectDir}/session-manager-operations/scheduler/epics/e1/prds/1-x.md`, content: 'x' },
  });
  expect(parsed).toEqual({ continue: true });
});

test('resolves the ops root through a git worktree checkout (Epic default isolation)', () => {
  // Mirrors gitWorktree.cjs's isolation: an active Epic's Terminal/Chat spawn
  // cwd is a separate worktree checkout, never the project cwd that owns
  // session-manager-operations/ — the hook must resolve back to the main
  // tree via git rather than going inert for every isolated Epic.
  const mainDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-guard-inline-main-'));
  spawnSync('git', ['init', '-q', mainDir]);
  spawnSync('git', ['-C', mainDir, 'commit', '--allow-empty', '-q', '-m', 'init']);
  const worktreeDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sm-guard-inline-wt-')), 'checkout');
  const addResult = spawnSync('git', ['-C', mainDir, 'worktree', 'add', '-q', '-b', 'test-branch', worktreeDir]);
  expect(addResult.status).toBe(0);

  const dir = path.join(mainDir, 'session-manager-operations', 'prompt-sessions');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'active-index.json'),
    JSON.stringify({
      sessions: { 'epic-1': { id: 'epic-1', claudeSessionId: 'sess-feature', tag: 'feature' } },
      events: [],
      tombstones: [],
    }),
  );

  try {
    const parsed = decide({
      session_id: 'sess-feature',
      tool_name: 'Write',
      cwd: worktreeDir,
      tool_input: { file_path: `${worktreeDir}/src/main/foo.cjs`, content: 'x' },
    });
    expect(parsed.hookSpecificOutput.permissionDecision).toBe('deny');
  } finally {
    spawnSync('git', ['-C', mainDir, 'worktree', 'remove', '--force', worktreeDir]);
    fs.rmSync(mainDir, { recursive: true, force: true });
    fs.rmSync(path.dirname(worktreeDir), { recursive: true, force: true });
  }
});

test('fails open on malformed stdin JSON', () => {
  const parsed = decide(parsePayload('{ not valid json'));
  expect(parsed).toEqual({ continue: true });
});

test('fails open when tool_input is missing entirely', () => {
  const parsed = decide({ tool_name: 'Write', cwd: projectDir, session_id: 'sess-feature' });
  expect(parsed).toEqual({ continue: true });
});

// ─────────────────────────────── smoke test: real process wiring
//
// The only test in this file that spawns the actual script as a child
// process — proves the CLI shape guard-inline-implementation.cjs's header
// documents (stdin JSON in, stdout JSON out) still works end-to-end.

test('smoke: real process wiring denies a Write to application source (stdin JSON in, stdout JSON out)', () => {
  writeIndex({
    'epic-1': { id: 'epic-1', claudeSessionId: 'sess-feature', tag: 'feature' },
  });
  const result = spawnSync(process.execPath, [HOOK_PATH], {
    input: JSON.stringify({
      session_id: 'sess-feature',
      tool_name: 'Write',
      cwd: projectDir,
      tool_input: { file_path: `${projectDir}/src/main/foo.cjs`, content: 'x' },
    }),
    encoding: 'utf8',
    timeout: 30_000,
  });
  expect(result.status).toBe(0);
  const parsed = JSON.parse(result.stdout);
  expect(parsed.hookSpecificOutput.permissionDecision).toBe('deny');
  expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain('/develop');
});

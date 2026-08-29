/**
 * guard-inline-implementation.test.cjs — PreToolUse hook contract tests for
 * scripts/hooks/guard-inline-implementation.cjs. Runs the real script as a
 * child process (stdin JSON in, stdout JSON out), same harness shape as
 * guard-prd-writes.test.cjs, against a real tmp "project" directory so the
 * hook's active-index.json lookup exercises real filesystem reads.
 *
 * Run: timeout 60 npx vitest run scripts/hooks/__tests__/guard-inline-implementation.test.cjs
 */

'use strict';

import { test, expect, beforeEach, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

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

function runHook(payload, env) {
  const input = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const result = spawnSync(process.execPath, [HOOK_PATH], {
    input,
    encoding: 'utf8',
    timeout: 10_000,
    env: { ...process.env, ...env },
  });
  let parsed = null;
  try {
    parsed = result.stdout ? JSON.parse(result.stdout) : null;
  } catch { /* asserted separately per test */ }
  return { ...result, parsed };
}

test('denies a Write to application source in a feature Epic', () => {
  writeIndex({
    'epic-1': { id: 'epic-1', claudeSessionId: 'sess-feature', tag: 'feature' },
  });
  const { parsed } = runHook({
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
  const { parsed } = runHook({
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
  const { parsed } = runHook({
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
  const { parsed } = runHook(
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
  const { parsed } = runHook({
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
  const { parsed } = runHook({
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
  const { parsed } = runHook({
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
    const { parsed } = runHook({
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
  const { parsed, status } = runHook('{ not valid json');
  expect(status).toBe(0);
  expect(parsed).toEqual({ continue: true });
});

test('fails open when tool_input is missing entirely', () => {
  const { parsed, status } = runHook({ tool_name: 'Write', cwd: projectDir, session_id: 'sess-feature' });
  expect(status).toBe(0);
  expect(parsed).toEqual({ continue: true });
});

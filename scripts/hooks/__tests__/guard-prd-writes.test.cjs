/**
 * guard-prd-writes.test.cjs — PreToolUse hook contract tests for
 * scripts/hooks/guard-prd-writes.cjs. Runs the real script as a child
 * process (it's invoked exactly this way by the harness — stdin JSON in,
 * stdout JSON out) rather than requiring it in-process, so the test exercises
 * the actual install shape.
 *
 * Run: timeout 60 npx vitest run scripts/hooks/__tests__/guard-prd-writes.test.cjs
 */

'use strict';

import { test, expect } from 'vitest';
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOOK_PATH = path.join(__dirname, '..', 'guard-prd-writes.cjs');
const FAKE_CWD = '/home/tester/Projects/session-manager';

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

test('denies a Write to a PRD path under an Epic\'s prds/ dir, naming scheduler_create_prd', () => {
  const { parsed, status } = runHook({
    tool_name: 'Write',
    cwd: FAKE_CWD,
    tool_input: {
      file_path: `${FAKE_CWD}/session-manager-operations/scheduler/epics/some-epic-abc123/prds/9001-hand-written.md`,
      content: '---\ntitle: x\n---\n',
    },
  });
  expect(status).toBe(0);
  expect(parsed.hookSpecificOutput.permissionDecision).toBe('deny');
  expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain('mcp__session-manager-scheduler__scheduler_create_prd');
});

test('denies an Edit to an existing PRD path, naming scheduler_update_prd', () => {
  const { parsed } = runHook({
    tool_name: 'Edit',
    cwd: FAKE_CWD,
    tool_input: {
      file_path: `${FAKE_CWD}/session-manager-operations/scheduler/epics/some-epic-abc123/prds/9001-hand-written.md`,
      old_string: 'a',
      new_string: 'b',
    },
  });
  expect(parsed.hookSpecificOutput.permissionDecision).toBe('deny');
  expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain('mcp__session-manager-scheduler__scheduler_update_prd');
});

test('denies a Write into prds-archived/, naming scheduler_archive_prd', () => {
  const { parsed } = runHook({
    tool_name: 'Write',
    cwd: FAKE_CWD,
    tool_input: {
      file_path: `${FAKE_CWD}/session-manager-operations/scheduler/epics/some-epic-abc123/prds-archived/9001-hand-written.md`,
      content: 'x',
    },
  });
  expect(parsed.hookSpecificOutput.permissionDecision).toBe('deny');
  expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain('mcp__session-manager-scheduler__scheduler_archive_prd');
});

test('exempts a fix-plan PRD filename (NN-fix-*) from denial', () => {
  const { parsed } = runHook({
    tool_name: 'Write',
    cwd: FAKE_CWD,
    tool_input: {
      file_path: `${FAKE_CWD}/session-manager-operations/scheduler/epics/some-epic-abc123/prds/9005-fix-flaky-test.md`,
      content: 'x',
    },
  });
  expect(parsed).toEqual({ continue: true });
});

test('allows a Read tool call unconditionally (not even inspected)', () => {
  const { parsed } = runHook({
    tool_name: 'Read',
    cwd: FAKE_CWD,
    tool_input: {
      file_path: `${FAKE_CWD}/session-manager-operations/scheduler/epics/some-epic-abc123/prds/9001-hand-written.md`,
    },
  });
  expect(parsed).toEqual({ continue: true });
});

test('allows a Write elsewhere in the repo, outside session-manager-operations/scheduler/', () => {
  const { parsed } = runHook({
    tool_name: 'Write',
    cwd: FAKE_CWD,
    tool_input: {
      file_path: `${FAKE_CWD}/src/main/scheduler.cjs`,
      content: 'x',
    },
  });
  expect(parsed).toEqual({ continue: true });
});

test('fails open on malformed stdin JSON', () => {
  const { parsed, status } = runHook('{ not valid json');
  expect(status).toBe(0);
  expect(parsed).toEqual({ continue: true });
});

test('fails open when tool_input is missing entirely', () => {
  const { parsed, status } = runHook({ tool_name: 'Write', cwd: FAKE_CWD });
  expect(status).toBe(0);
  expect(parsed).toEqual({ continue: true });
});

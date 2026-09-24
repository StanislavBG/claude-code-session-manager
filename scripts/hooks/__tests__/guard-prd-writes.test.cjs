/**
 * guard-prd-writes.test.cjs — PreToolUse hook contract tests for
 * scripts/hooks/guard-prd-writes.cjs.
 *
 * Exercises `decide()`/`parsePayload()` from
 * scripts/hooks/lib/guard-prd-writes-policy.cjs — the decision logic the CLI
 * wraps — in-process for every policy case. That module is fully I/O-free
 * (pure path arithmetic on the payload), so requiring it directly is
 * equivalent to the real decision the CLI makes, just without paying for a
 * CLI child-process spawn per case. (The CLI file itself can't be safely
 * `require()`d from a test: it runs its stdin-read-then-process.exit main()
 * as a require-time side effect — deliberately, see its header — which would
 * hang/kill the test process.)
 *
 * Same class of fix as guard-destructive-git.test.cjs (PRD 1412): this file
 * used to spawn the real CLI process once per case (8 spawns) with a shared
 * `timeout: 10_000` — same mechanism that flaked under full-suite
 * parallel-worker load, just fewer spawns. Only ONE test (the "smoke test"
 * section at the bottom) still spawns the real CLI script as a child process,
 * to prove the actual install shape (stdin JSON in, stdout JSON out) works.
 *
 * Run: timeout 60 npx vitest run scripts/hooks/__tests__/guard-prd-writes.test.cjs
 */

'use strict';

import { test, expect } from 'vitest';
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { decide, parsePayload } = require('../lib/guard-prd-writes-policy.cjs');

const HOOK_PATH = path.join(__dirname, '..', 'guard-prd-writes.cjs');
const FAKE_CWD = '/home/tester/Projects/session-manager';

test('denies a Write to a PRD path under an Epic\'s prds/ dir, naming scheduler_create_prd', () => {
  const parsed = decide({
    tool_name: 'Write',
    cwd: FAKE_CWD,
    tool_input: {
      file_path: `${FAKE_CWD}/session-manager-operations/scheduler/epics/some-epic-abc123/prds/9001-hand-written.md`,
      content: '---\ntitle: x\n---\n',
    },
  });
  expect(parsed.hookSpecificOutput.permissionDecision).toBe('deny');
  expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain('mcp__session-manager-scheduler__scheduler_create_prd');
});

test('denies an Edit to an existing PRD path, naming scheduler_update_prd', () => {
  const parsed = decide({
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
  const parsed = decide({
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
  const parsed = decide({
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
  const parsed = decide({
    tool_name: 'Read',
    cwd: FAKE_CWD,
    tool_input: {
      file_path: `${FAKE_CWD}/session-manager-operations/scheduler/epics/some-epic-abc123/prds/9001-hand-written.md`,
    },
  });
  expect(parsed).toEqual({ continue: true });
});

test('allows a Write elsewhere in the repo, outside session-manager-operations/scheduler/', () => {
  const parsed = decide({
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
  const parsed = decide(parsePayload('{ not valid json'));
  expect(parsed).toEqual({ continue: true });
});

test('fails open when tool_input is missing entirely', () => {
  const parsed = decide({ tool_name: 'Write', cwd: FAKE_CWD });
  expect(parsed).toEqual({ continue: true });
});

// ─────────────────────────────── smoke test: real process wiring
//
// The only test in this file that spawns the actual script as a child
// process — proves the CLI shape guard-prd-writes.cjs's header documents
// (stdin JSON in, stdout JSON out) still works end-to-end.

test('smoke: real process wiring denies a Write to a PRD path (stdin JSON in, stdout JSON out)', () => {
  const result = spawnSync(process.execPath, [HOOK_PATH], {
    input: JSON.stringify({
      tool_name: 'Write',
      cwd: FAKE_CWD,
      tool_input: {
        file_path: `${FAKE_CWD}/session-manager-operations/scheduler/epics/some-epic-abc123/prds/9001-hand-written.md`,
        content: '---\ntitle: x\n---\n',
      },
    }),
    encoding: 'utf8',
    timeout: 30_000,
  });
  expect(result.status).toBe(0);
  const parsed = JSON.parse(result.stdout);
  expect(parsed.hookSpecificOutput.permissionDecision).toBe('deny');
  expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain('mcp__session-manager-scheduler__scheduler_create_prd');
});

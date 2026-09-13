/**
 * guard-self-schedule.test.cjs — PreToolUse hook contract tests for
 * scripts/hooks/guard-self-schedule.cjs. Runs the real script as a child
 * process (stdin JSON in, stdout JSON out), same harness shape as
 * guard-prd-writes.test.cjs / guard-inline-implementation.test.cjs.
 *
 * Run: timeout 60 npx vitest run scripts/hooks/__tests__/guard-self-schedule.test.cjs
 */

'use strict';

import { test, expect } from 'vitest';
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOOK_PATH = path.join(__dirname, '..', 'guard-self-schedule.cjs');
const IN_RUN_ENV = { SM_SCHEDULER_JOB_SLUG: '123-test-job' };

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

test('denies ScheduleWakeup inside a headless scheduler run', () => {
  const { parsed } = runHook(
    { tool_name: 'ScheduleWakeup', tool_input: { delaySeconds: 600, reason: 'wait', noop: false } },
    IN_RUN_ENV,
  );
  expect(parsed.hookSpecificOutput.permissionDecision).toBe('deny');
  expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain('never re-queue or self-schedule');
  expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain('standards.md:85');
});

test('denies CronCreate inside a headless scheduler run', () => {
  const { parsed } = runHook(
    { tool_name: 'CronCreate', tool_input: { schedule: '0 * * * *', prompt: 'check in' } },
    IN_RUN_ENV,
  );
  expect(parsed.hookSpecificOutput.permissionDecision).toBe('deny');
  expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain('never re-queue or self-schedule');
});

test('denies a backgrounded Task (Agent) call inside a headless scheduler run', () => {
  const { parsed } = runHook(
    { tool_name: 'Task', tool_input: { description: 'review', prompt: 'run /code-review', run_in_background: true } },
    IN_RUN_ENV,
  );
  expect(parsed.hookSpecificOutput.permissionDecision).toBe('deny');
  expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain('run_in_background');
});

test('denies a backgrounded Agent call (alternate tool name) inside a headless scheduler run', () => {
  const { parsed } = runHook(
    { tool_name: 'Agent', tool_input: { description: 'review', prompt: 'run /security-review', run_in_background: true } },
    IN_RUN_ENV,
  );
  expect(parsed.hookSpecificOutput.permissionDecision).toBe('deny');
});

test('allows a synchronous inline Task/Agent call (no run_in_background) inside a headless scheduler run', () => {
  const { parsed } = runHook(
    { tool_name: 'Task', tool_input: { description: 'review', prompt: 'run /code-review' } },
    IN_RUN_ENV,
  );
  expect(parsed).toEqual({ continue: true });
});

test('allows a Task call with run_in_background explicitly false inside a headless scheduler run', () => {
  const { parsed } = runHook(
    { tool_name: 'Task', tool_input: { description: 'review', prompt: 'run /code-review', run_in_background: false } },
    IN_RUN_ENV,
  );
  expect(parsed).toEqual({ continue: true });
});

test('allows an unrelated tool (e.g. Skill) inside a headless scheduler run', () => {
  const { parsed } = runHook(
    { tool_name: 'Skill', tool_input: { skill: 'code-review' } },
    IN_RUN_ENV,
  );
  expect(parsed).toEqual({ continue: true });
});

test('allows ScheduleWakeup when the scheduler env marker is absent (interactive session)', () => {
  const { parsed } = runHook({ tool_name: 'ScheduleWakeup', tool_input: { delaySeconds: 600, reason: 'wait', noop: false } });
  expect(parsed).toEqual({ continue: true });
});

test('allows CronCreate when the scheduler env marker is absent (interactive session)', () => {
  const { parsed } = runHook({ tool_name: 'CronCreate', tool_input: { schedule: '0 * * * *', prompt: 'check in' } });
  expect(parsed).toEqual({ continue: true });
});

test('allows a backgrounded Task call when the scheduler env marker is absent (interactive session)', () => {
  const { parsed } = runHook({ tool_name: 'Task', tool_input: { description: 'review', prompt: 'go', run_in_background: true } });
  expect(parsed).toEqual({ continue: true });
});

test('allows a backgrounded Agent call when the scheduler env marker is absent (interactive session)', () => {
  const { parsed } = runHook({ tool_name: 'Agent', tool_input: { description: 'review', prompt: 'go', run_in_background: true } });
  expect(parsed).toEqual({ continue: true });
});

test('fails open on malformed stdin JSON', () => {
  const { parsed, status } = runHook('{ not valid json', IN_RUN_ENV);
  expect(status).toBe(0);
  expect(parsed).toEqual({ continue: true });
});

test('fails open when tool_input is missing entirely', () => {
  const { parsed, status } = runHook({ tool_name: 'Task' }, IN_RUN_ENV);
  expect(status).toBe(0);
  expect(parsed).toEqual({ continue: true });
});

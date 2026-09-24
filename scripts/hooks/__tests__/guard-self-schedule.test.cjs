/**
 * guard-self-schedule.test.cjs — PreToolUse hook contract tests for
 * scripts/hooks/guard-self-schedule.cjs.
 *
 * Exercises `decide()`/`parsePayload()` from
 * scripts/hooks/lib/guard-self-schedule-policy.cjs — the decision logic the
 * CLI wraps — in-process for every policy case. Requiring that module has no
 * I/O of its own (it only reads `process.env.SM_SCHEDULER_JOB_SLUG` and the
 * payload), so requiring it directly is equivalent to the real decision the
 * CLI makes, just without paying for a CLI child-process spawn per case. (The
 * CLI file itself can't be safely `require()`d from a test: it runs its
 * stdin-read-then-process.exit main() as a require-time side effect —
 * deliberately, see its header — which would hang/kill the test process.)
 *
 * Same class of fix as guard-destructive-git.test.cjs (PRD 1412): this file
 * used to spawn the real CLI process once per case (13 spawns) with a shared
 * `timeout: 10_000` — same mechanism that flaked under full-suite
 * parallel-worker load, just fewer spawns. Only ONE test (the "smoke test"
 * section at the bottom) still spawns the real CLI script as a child process,
 * to prove the actual install shape (stdin JSON in, stdout JSON out) works.
 *
 * Run: timeout 60 npx vitest run scripts/hooks/__tests__/guard-self-schedule.test.cjs
 */

'use strict';

import { test, expect } from 'vitest';
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { decide, parsePayload } = require('../lib/guard-self-schedule-policy.cjs');

const HOOK_PATH = path.join(__dirname, '..', 'guard-self-schedule.cjs');

const IN_RUN = '123-test-job';
const NO_RUN = null; // sentinel: env marker absent (interactive session)

/**
 * Runs `decide()` in-process with `SM_SCHEDULER_JOB_SLUG` set to `jobSlug`
 * (or removed entirely when `jobSlug` is `NO_RUN`) for the duration of the
 * call, then restores whatever the ambient value was — this suite may itself
 * run inside a scheduler job. `jobSlug` is required (not defaulted) so a
 * caller can't accidentally fall through to the "in run" case by passing
 * `undefined` — a JS default parameter treats an explicit `undefined` the
 * same as an omitted argument.
 */
function decideInRun(payload, jobSlug) {
  const prev = process.env.SM_SCHEDULER_JOB_SLUG;
  if (jobSlug == null) delete process.env.SM_SCHEDULER_JOB_SLUG;
  else process.env.SM_SCHEDULER_JOB_SLUG = jobSlug;
  try {
    return decide(payload);
  } finally {
    if (prev === undefined) delete process.env.SM_SCHEDULER_JOB_SLUG;
    else process.env.SM_SCHEDULER_JOB_SLUG = prev;
  }
}

test('denies ScheduleWakeup inside a headless scheduler run', () => {
  const parsed = decideInRun({ tool_name: 'ScheduleWakeup', tool_input: { delaySeconds: 600, reason: 'wait', noop: false } }, IN_RUN);
  expect(parsed.hookSpecificOutput.permissionDecision).toBe('deny');
  expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain('never re-queue or self-schedule');
  expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain('standards.md:85');
});

test('denies CronCreate inside a headless scheduler run', () => {
  const parsed = decideInRun({ tool_name: 'CronCreate', tool_input: { schedule: '0 * * * *', prompt: 'check in' } }, IN_RUN);
  expect(parsed.hookSpecificOutput.permissionDecision).toBe('deny');
  expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain('never re-queue or self-schedule');
});

test('denies a backgrounded Task (Agent) call inside a headless scheduler run', () => {
  const parsed = decideInRun({ tool_name: 'Task', tool_input: { description: 'review', prompt: 'run /code-review', run_in_background: true } }, IN_RUN);
  expect(parsed.hookSpecificOutput.permissionDecision).toBe('deny');
  expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain('run_in_background');
});

test('denies a backgrounded Agent call (alternate tool name) inside a headless scheduler run', () => {
  const parsed = decideInRun({ tool_name: 'Agent', tool_input: { description: 'review', prompt: 'run /security-review', run_in_background: true } }, IN_RUN);
  expect(parsed.hookSpecificOutput.permissionDecision).toBe('deny');
});

test('allows a synchronous inline Task/Agent call (no run_in_background) inside a headless scheduler run', () => {
  const parsed = decideInRun({ tool_name: 'Task', tool_input: { description: 'review', prompt: 'run /code-review' } }, IN_RUN);
  expect(parsed).toEqual({ continue: true });
});

test('allows a Task call with run_in_background explicitly false inside a headless scheduler run', () => {
  const parsed = decideInRun({ tool_name: 'Task', tool_input: { description: 'review', prompt: 'run /code-review', run_in_background: false } }, IN_RUN);
  expect(parsed).toEqual({ continue: true });
});

test('allows an unrelated tool (e.g. Skill) inside a headless scheduler run', () => {
  const parsed = decideInRun({ tool_name: 'Skill', tool_input: { skill: 'code-review' } }, IN_RUN);
  expect(parsed).toEqual({ continue: true });
});

test('allows ScheduleWakeup when the scheduler env marker is absent (interactive session)', () => {
  const parsed = decideInRun({ tool_name: 'ScheduleWakeup', tool_input: { delaySeconds: 600, reason: 'wait', noop: false } }, NO_RUN);
  expect(parsed).toEqual({ continue: true });
});

test('allows CronCreate when the scheduler env marker is absent (interactive session)', () => {
  const parsed = decideInRun({ tool_name: 'CronCreate', tool_input: { schedule: '0 * * * *', prompt: 'check in' } }, NO_RUN);
  expect(parsed).toEqual({ continue: true });
});

test('allows a backgrounded Task call when the scheduler env marker is absent (interactive session)', () => {
  const parsed = decideInRun({ tool_name: 'Task', tool_input: { description: 'review', prompt: 'go', run_in_background: true } }, NO_RUN);
  expect(parsed).toEqual({ continue: true });
});

test('allows a backgrounded Agent call when the scheduler env marker is absent (interactive session)', () => {
  const parsed = decideInRun({ tool_name: 'Agent', tool_input: { description: 'review', prompt: 'go', run_in_background: true } }, NO_RUN);
  expect(parsed).toEqual({ continue: true });
});

test('fails open on malformed stdin JSON', () => {
  const parsed = decideInRun(parsePayload('{ not valid json'), IN_RUN);
  expect(parsed).toEqual({ continue: true });
});

test('fails open when tool_input is missing entirely', () => {
  const parsed = decideInRun({ tool_name: 'Task' }, IN_RUN);
  expect(parsed).toEqual({ continue: true });
});

// ─────────────────────────────── smoke test: real process wiring
//
// The only test in this file that spawns the actual script as a child
// process — proves the CLI shape guard-self-schedule.cjs's header documents
// (stdin JSON in, stdout JSON out) still works end-to-end.

test('smoke: real process wiring denies ScheduleWakeup (stdin JSON in, stdout JSON out)', () => {
  // Strip the ambient marker: this suite may itself run inside a scheduler job.
  const { SM_SCHEDULER_JOB_SLUG: _ambient, ...cleanEnv } = process.env;
  const result = spawnSync(process.execPath, [HOOK_PATH], {
    input: JSON.stringify({ tool_name: 'ScheduleWakeup', tool_input: { delaySeconds: 600, reason: 'wait', noop: false } }),
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...cleanEnv, SM_SCHEDULER_JOB_SLUG: '123-test-job' },
  });
  expect(result.status).toBe(0);
  const parsed = JSON.parse(result.stdout);
  expect(parsed.hookSpecificOutput.permissionDecision).toBe('deny');
  expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain('never re-queue or self-schedule');
});

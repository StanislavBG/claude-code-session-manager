/**
 * rcaReport.test.cjs — unit tests for src/main/lib/scheduler/rcaReport.cjs.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/rcaReport.test.cjs
 */

'use strict';

import { test, expect, beforeEach, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let tmpHome;
let realHome;
let rcaReport;

// config.cjs bakes os.homedir() into top-level consts at first require
// (allowedRoots/WRITE_PREFIXES). Node's require cache must be purged per test
// so each test's tmpHome takes effect — vi.resetModules() only resets vitest's
// ESM graph, not require().
const MODULES_TO_RELOAD = ['../lib/scheduler/rcaReport.cjs', '../config.cjs'];

function purgeRequireCache() {
  for (const m of MODULES_TO_RELOAD) {
    try { delete require.cache[require.resolve(m)]; } catch { /* not loaded yet */ }
  }
}

beforeEach(() => {
  realHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'rca-report-test-'));
  process.env.HOME = tmpHome;
  delete process.env.SM_RCA_DISABLE;
  purgeRequireCache();
  rcaReport = require('../lib/scheduler/rcaReport.cjs');
});

afterEach(() => {
  process.env.HOME = realHome;
  delete process.env.SM_RCA_DISABLE;
  fs.rmSync(tmpHome, { recursive: true, force: true });
  purgeRequireCache();
});

// ─── helpers ──────────────────────────────────────────────────────────────────

function makeProject(name = 'proj') {
  const cwd = path.join(tmpHome, name);
  fs.mkdirSync(cwd, { recursive: true });
  return cwd;
}

function writeRun(runDir, slug, { logLines = ['line1', 'line2'], exitCode = 1, durationMs = 1234 } = {}) {
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, `${slug}.log`), logLines.join('\n') + '\n');
  fs.writeFileSync(path.join(runDir, `${slug}.meta.json`), JSON.stringify({ exitCode, durationMs }));
}

function writePrd(cwd, slug, { acBody = '- [ ] `timeout 10 echo ok` passes.' } = {}) {
  const prdsDir = path.join(cwd, 'session-manager-operations', 'scheduler', 'prds');
  fs.mkdirSync(prdsDir, { recursive: true });
  const body = ['---', `title: ${slug}`, '---', '', '# Goal', '', 'Do the thing.', '', '# Acceptance criteria', '', acBody, '', '# Out of scope', '', '- N/A'].join('\n');
  fs.writeFileSync(path.join(prdsDir, `${slug}.md`), body);
}

function baseJob(overrides = {}) {
  return { slug: 'testslug', runId: '2026-07-24T00-00-00-000Z', exitCode: 1, error: 'something broke', ...overrides };
}

function readSessions(cwd) {
  const p = path.join(cwd, 'session-manager-operations', 'prompt-sessions', 'active-index.json');
  if (!fs.existsSync(p)) return {};
  return JSON.parse(fs.readFileSync(p, 'utf8')).sessions ?? {};
}

// ─── report writing ──────────────────────────────────────────────────────────

test('writeRcaReport: writes root-cause-<slug>.md into the run directory', async () => {
  const cwd = makeProject();
  const runDir = path.join(tmpHome, 'run1');
  writeRun(runDir, 'testslug');
  writePrd(cwd, 'testslug');

  const res = await rcaReport.writeRcaReport({ job: baseJob({ cwd }), runDir, verdict: 'transcript_errors' });

  expect(res.filed).toBe(true);
  expect(res.path).toBe(path.join(runDir, 'root-cause-testslug.md'));
  const body = fs.readFileSync(res.path, 'utf8');
  expect(body).toContain('prdSlug: testslug');
  expect(body).toContain('# What happened');
  expect(body).toContain('# The PRD\'s acceptance criteria');
  expect(body).toContain('timeout 10 echo ok');
  expect(res.summary).toContain('testslug');
  expect(res.summary.split('\n')).toHaveLength(1);
});

test('writeRcaReport: creates no Epic — a parked job never opens work on its own', async () => {
  const cwd = makeProject();
  const runDir = path.join(tmpHome, 'run1');
  writeRun(runDir, 'testslug');
  writePrd(cwd, 'testslug');

  await rcaReport.writeRcaReport({ job: baseJob({ cwd }), runDir, verdict: 'transcript_errors' });

  expect(readSessions(cwd)).toEqual({});
});

test('writeRcaReport: a second call for the same run overwrites in place, never duplicates', async () => {
  const cwd = makeProject();
  const runDir = path.join(tmpHome, 'run1');
  writeRun(runDir, 'testslug');
  writePrd(cwd, 'testslug');
  const job = baseJob({ cwd });

  const first = await rcaReport.writeRcaReport({ job, runDir, verdict: 'transcript_errors' });
  const second = await rcaReport.writeRcaReport({ job, runDir, verdict: 'transcript_errors' });

  expect(second.path).toBe(first.path);
  expect(fs.readdirSync(runDir).filter((f) => f.startsWith('root-cause-'))).toHaveLength(1);
});

test('writeRcaReport: investigationText enriches the report in place', async () => {
  const cwd = makeProject();
  const runDir = path.join(tmpHome, 'run1');
  writeRun(runDir, 'testslug');
  writePrd(cwd, 'testslug');
  const job = baseJob({ cwd });

  const first = await rcaReport.writeRcaReport({ job, runDir, verdict: 'transcript_errors' });
  expect(fs.readFileSync(first.path, 'utf8')).not.toContain('## Investigation analysis');

  const second = await rcaReport.writeRcaReport({
    job, runDir, verdict: 'transcript_errors', investigationText: 'Root cause: forgot to bound the poll loop.',
  });

  expect(second.path).toBe(first.path);
  const enriched = fs.readFileSync(second.path, 'utf8');
  expect(enriched).toContain('## Investigation analysis');
  expect(enriched).toContain('forgot to bound the poll loop');
});

test('writeRcaReport: works for a job whose PRD cannot be read (no acceptance criteria on record)', async () => {
  const cwd = makeProject('bare-proj');
  const runDir = path.join(tmpHome, 'run1');
  writeRun(runDir, 'testslug');

  const res = await rcaReport.writeRcaReport({ job: baseJob({ cwd }), runDir, verdict: 'transcript_errors' });

  expect(res.filed).toBe(true);
  expect(fs.readFileSync(res.path, 'utf8')).toContain('acceptance criteria not found');
});

// ─── PRD lookup: Epic prds/, Epic prds-archived/, fallback ───────────────────

function writeEpicPrd(cwd, epicId, sub, slug, acBody) {
  const dir = path.join(cwd, 'session-manager-operations', 'scheduler', 'epics', epicId, sub);
  fs.mkdirSync(dir, { recursive: true });
  const body = ['---', `title: ${slug}`, '---', '', '# Goal', '', 'Do it.', '', '# Acceptance criteria', '', acBody, '', '# Out of scope', '', '- N/A'].join('\n');
  fs.writeFileSync(path.join(dir, `${slug}.md`), body);
}

test('writeRcaReport: quotes criteria from the job\'s own Epic prds/ dir', async () => {
  const cwd = makeProject();
  const runDir = path.join(tmpHome, 'run1');
  writeRun(runDir, 'testslug');
  writeEpicPrd(cwd, 'epic-abc', 'prds', 'testslug', '- [ ] ac-1: epic live criterion');

  const res = await rcaReport.writeRcaReport({ job: baseJob({ cwd, epicId: 'epic-abc' }), runDir, verdict: 'transcript_errors' });

  const body = fs.readFileSync(res.path, 'utf8');
  const section = body.split("# The PRD's acceptance criteria")[1] ?? '';
  expect(section).toContain('epic live criterion');
  expect(body).not.toContain('acceptance criteria not found');
});

test('writeRcaReport: finds a PRD in another Epic prds/ dir of the project when epicId is absent', async () => {
  const cwd = makeProject();
  const runDir = path.join(tmpHome, 'run1');
  writeRun(runDir, 'testslug');
  writeEpicPrd(cwd, 'other-epic', 'prds', 'testslug', '- [ ] ac-1: sibling epic criterion');

  const res = await rcaReport.writeRcaReport({ job: baseJob({ cwd }), runDir, verdict: 'transcript_errors' });

  expect(fs.readFileSync(res.path, 'utf8')).toContain('sibling epic criterion');
});

test('writeRcaReport: quotes criteria from an Epic prds-archived/ twin', async () => {
  const cwd = makeProject();
  const runDir = path.join(tmpHome, 'run1');
  writeRun(runDir, 'testslug');
  writeEpicPrd(cwd, 'epic-abc', 'prds-archived', 'testslug', '- [ ] ac-1: archived criterion');

  const res = await rcaReport.writeRcaReport({ job: baseJob({ cwd, epicId: 'epic-abc' }), runDir, verdict: 'transcript_errors' });

  const body = fs.readFileSync(res.path, 'utf8');
  expect(body).toContain('archived criterion');
  expect(body).not.toContain('acceptance criteria not found');
});

test('writeRcaReport: a PRD found nowhere (Epic dirs exist) still gets the not-found fallback', async () => {
  const cwd = makeProject();
  const runDir = path.join(tmpHome, 'run1');
  writeRun(runDir, 'testslug');
  writeEpicPrd(cwd, 'epic-abc', 'prds', 'otherslug', '- [ ] ac-1: unrelated');

  const res = await rcaReport.writeRcaReport({ job: baseJob({ cwd, epicId: 'epic-abc' }), runDir, verdict: 'transcript_errors' });

  const body = fs.readFileSync(res.path, 'utf8');
  expect(body).toContain('acceptance criteria not found');
  expect(body).not.toContain('unrelated');
});

test('writeRcaReport: an unsafe epicId is skipped and the lookup continues with the Epic prds/ dirs', async () => {
  const cwd = makeProject();
  const runDir = path.join(tmpHome, 'run1');
  writeRun(runDir, 'testslug');
  writeEpicPrd(cwd, 'real-epic', 'prds', 'testslug', '- [ ] ac-1: found despite bad epicId');

  const res = await rcaReport.writeRcaReport({ job: baseJob({ cwd, epicId: '../x' }), runDir, verdict: 'transcript_errors' });

  expect(res.filed).toBe(true);
  expect(fs.readFileSync(res.path, 'utf8')).toContain('found despite bad epicId');
});

// ─── skip paths ──────────────────────────────────────────────────────────────

test('writeRcaReport: rejects a slug containing path-traversal segments', async () => {
  const cwd = makeProject();
  const runDir = path.join(tmpHome, 'run1');
  fs.mkdirSync(runDir, { recursive: true });

  const res = await rcaReport.writeRcaReport({ job: baseJob({ cwd, slug: '../../etc/passwd' }), runDir, verdict: 'transcript_errors' });

  expect(res.filed).toBe(false);
  expect(res.reason).toBe('unsafe-slug');
});

test('writeRcaReport: skips when there is no run directory to write into', async () => {
  const cwd = makeProject();

  const res = await rcaReport.writeRcaReport({ job: baseJob({ cwd }), verdict: 'transcript_errors' });

  expect(res.filed).toBe(false);
  expect(res.reason).toBe('no-run-dir');
});

// ─── recovery actions ────────────────────────────────────────────────────────

test('RECOVERY_ACTIONS: every FAILURE_CLASSES member has an entry from the closed set', () => {
  const CLOSED_SET = new Set(['archive', 'resume-and-commit', 'verify-and-close', 'investigate']);
  for (const failureClass of Object.values(rcaReport.FAILURE_CLASSES)) {
    expect(rcaReport.RECOVERY_ACTIONS).toHaveProperty(failureClass);
    expect(CLOSED_SET.has(rcaReport.RECOVERY_ACTIONS[failureClass])).toBe(true);
  }
});

/** One stream-json assistant event carrying a single Bash tool_use. */
function bashToolUse(command) {
  return JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command, description: 'x' } }] } });
}

/** One stream-json assistant event carrying a single text block. */
function assistantText(text) {
  return JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
}

test('recoveryActionFor: maps each known failure class to its expected action', () => {
  const { FAILURE_CLASSES, recoveryActionFor } = rcaReport;
  expect(recoveryActionFor(FAILURE_CLASSES.ALREADY_SHIPPED)).toBe('archive');
  expect(recoveryActionFor(FAILURE_CLASSES.UNCOMMITTED)).toBe('resume-and-commit');
  expect(recoveryActionFor(FAILURE_CLASSES.NO_SENTINEL)).toBe('verify-and-close');
  expect(recoveryActionFor(FAILURE_CLASSES.SELF_QUEUE)).toBe('investigate');
  expect(recoveryActionFor(FAILURE_CLASSES.STUCK_LOOP)).toBe('investigate');
  expect(recoveryActionFor(FAILURE_CLASSES.POST_AC_OVERRUN)).toBe('investigate');
  expect(recoveryActionFor(FAILURE_CLASSES.TRANSCRIPT_ERRORS)).toBe('investigate');
  expect(recoveryActionFor(FAILURE_CLASSES.UNKNOWN)).toBe('investigate');
  expect(recoveryActionFor(FAILURE_CLASSES.EXECUTOR_FAIL)).toBe('investigate');
});

test('FAILURE_CLASSES / RECOVERY_ACTIONS: pre-existing values are unchanged, EXECUTOR_FAIL is added', () => {
  const { FAILURE_CLASSES, RECOVERY_ACTIONS } = rcaReport;
  expect(FAILURE_CLASSES).toEqual({
    ALREADY_SHIPPED: 'already-shipped',
    SELF_QUEUE: 'self-queue',
    STUCK_LOOP: 'stuck-loop',
    POST_AC_OVERRUN: 'post-ac-overrun',
    NO_SENTINEL: 'no-sentinel',
    UNCOMMITTED: 'uncommitted-changes',
    TRANSCRIPT_ERRORS: 'transcript-errors',
    ABANDONED_BACKGROUND_TASK: 'abandoned-background-task',
    BLOCKED_BY_FOREIGN_WIP: 'blocked-by-foreign-wip',
    EXECUTOR_FAIL: 'executor-fail',
    UNKNOWN: 'unknown',
  });
  expect(RECOVERY_ACTIONS).toEqual({
    'already-shipped': 'archive',
    'self-queue': 'investigate',
    'stuck-loop': 'investigate',
    'post-ac-overrun': 'investigate',
    'no-sentinel': 'verify-and-close',
    'uncommitted-changes': 'resume-and-commit',
    'transcript-errors': 'investigate',
    'abandoned-background-task': 'investigate',
    'blocked-by-foreign-wip': 'archive',
    'executor-fail': 'investigate',
    unknown: 'investigate',
  });
});

test('classifyFailure: sentinel_fail is executor-fail even when the tail has loop-word prose', () => {
  const { classifyFailure, FAILURE_CLASSES } = rcaReport;
  expect(classifyFailure({ verdict: 'sentinel_fail', logTail: 'The choice stays until you pass --max-findings default.' })).toBe(FAILURE_CLASSES.EXECUTOR_FAIL);
  expect(classifyFailure({ verdict: 'sentinel_fail', logTail: 'HUMAN_ACTION_REQUIRED: builds 2-4 are expired\nwhile true is not used here' })).toBe(FAILURE_CLASSES.EXECUTOR_FAIL);
  // Earlier rules still win over executor-fail.
  expect(classifyFailure({ verdict: 'sentinel_fail', logTail: 'Launching skill: session-manager-dev:develop' })).toBe(FAILURE_CLASSES.SELF_QUEUE);
});

test('classifyFailure: prose in an assistant text event never matches stuck-loop', () => {
  const { classifyFailure, FAILURE_CLASSES } = rcaReport;
  expect(classifyFailure({ verdict: 'silent_no_op', logTail: assistantText('files stay dirty until someone commits') })).toBe(FAILURE_CLASSES.UNCOMMITTED);
  expect(classifyFailure({ verdict: 'silent_no_op', logTail: 'plain text: while true; do sleep 1; done' })).toBe(FAILURE_CLASSES.UNCOMMITTED);
  const toolResult = JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'until x; do sleep 5; done' }] } });
  expect(classifyFailure({ verdict: 'silent_no_op', logTail: toolResult })).toBe(FAILURE_CLASSES.UNCOMMITTED);
});

test('classifyFailure: only an unbounded Bash loop command is stuck-loop', () => {
  const { classifyFailure, FAILURE_CLASSES } = rcaReport;
  expect(classifyFailure({ verdict: 'transcript_errors', logTail: bashToolUse('until curl -sf http://127.0.0.1:9/x; do sleep 5; done') })).toBe(FAILURE_CLASSES.STUCK_LOOP);
  expect(classifyFailure({ verdict: 'transcript_errors', logTail: bashToolUse('while :\ndo sleep 1\ndone') })).toBe(FAILURE_CLASSES.STUCK_LOOP);
  for (const cmd of [
    "timeout 300 bash -c 'until curl -sf http://127.0.0.1:9/x; do sleep 5; done'",
    'for i in 1 2 3; do sleep 30; done',
    'git commit -m "hold until the agreement is accepted"',
    'sleep 30',
  ]) {
    expect(classifyFailure({ verdict: 'transcript_errors', logTail: bashToolUse(cmd) })).not.toBe(FAILURE_CLASSES.STUCK_LOOP);
  }
});

test('bashCommandsIn: returns only Bash tool_use commands, skipping malformed and non-Bash lines', () => {
  const lines = [
    bashToolUse('echo hi'),
    '{"type":"assistant","tool_use" "Bash" broken',
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/x' } }] } }),
    assistantText('Bash tool_use until'),
    'plain "tool_use" "Bash" line',
  ];
  expect(rcaReport.bashCommandsIn(lines)).toEqual(['echo hi']);
});

test('recoveryActionFor: defaults to investigate for an unrecognised class', () => {
  expect(rcaReport.recoveryActionFor('totally-made-up-class')).toBe('investigate');
  expect(rcaReport.recoveryActionFor(undefined)).toBe('investigate');
});

test('writeRcaReport: markdown carries a machine-readable recovery-action line matching recoveryActionFor, for each failure class', async () => {
  const cwd = makeProject();
  const runDir = path.join(tmpHome, 'run1');
  writeRun(runDir, 'testslug');
  writePrd(cwd, 'testslug');

  const cases = [
    { verdict: 'pass_no_commit', logTail: 'The work was already implemented in a prior commit.', expectedClass: rcaReport.FAILURE_CLASSES.ALREADY_SHIPPED },
    { verdict: 'transcript_errors', logTail: 'Launching skill: session-manager-dev:develop', expectedClass: rcaReport.FAILURE_CLASSES.SELF_QUEUE },
    { verdict: 'transcript_errors', logTail: bashToolUse('while true; do sleep 1; done'), expectedClass: rcaReport.FAILURE_CLASSES.STUCK_LOOP },
    { verdict: 'sentinel_fail', logTail: 'The choice stays until you pass --max-findings default.', expectedClass: rcaReport.FAILURE_CLASSES.EXECUTOR_FAIL },
    { verdict: 'uncommitted_changes', logTail: 'plain log tail', expectedClass: rcaReport.FAILURE_CLASSES.UNCOMMITTED },
    { verdict: 'no_verdict_sentinel', logTail: 'plain log tail', expectedClass: rcaReport.FAILURE_CLASSES.NO_SENTINEL },
    { verdict: 'transcript_errors', logTail: 'plain log tail', expectedClass: rcaReport.FAILURE_CLASSES.TRANSCRIPT_ERRORS },
    { verdict: 'some_other_verdict', logTail: 'plain log tail', expectedClass: rcaReport.FAILURE_CLASSES.UNKNOWN },
  ];

  for (const { verdict, logTail, expectedClass } of cases) {
    writeRun(runDir, 'testslug', { logLines: logTail.split('\n') });
    const res = await rcaReport.writeRcaReport({ job: baseJob({ cwd }), runDir, verdict });
    expect(res.failureClass).toBe(expectedClass);
    const expectedAction = rcaReport.recoveryActionFor(expectedClass);
    expect(res.recoveryAction).toBe(expectedAction);
    const body = fs.readFileSync(res.path, 'utf8');
    expect(body).toContain(`recovery-action: ${expectedAction}`);
  }
});

test('writeRcaReport: SM_RCA_DISABLE=1 skips without writing', async () => {
  process.env.SM_RCA_DISABLE = '1';
  const cwd = makeProject();
  const runDir = path.join(tmpHome, 'run1');
  writeRun(runDir, 'testslug');
  writePrd(cwd, 'testslug');

  const res = await rcaReport.writeRcaReport({ job: baseJob({ cwd }), runDir, verdict: 'transcript_errors' });

  expect(res.filed).toBe(false);
  expect(res.reason).toBe('disabled');
  expect(fs.readdirSync(runDir).filter((f) => f.startsWith('root-cause-'))).toHaveLength(0);
});

test('classifyFailure: blocked_by_foreign_wip_streak verdict classifies as BLOCKED_BY_FOREIGN_WIP, never UNKNOWN', () => {
  const failureClass = rcaReport.classifyFailure({ verdict: 'blocked_by_foreign_wip_streak', logTail: 'anything' });
  expect(failureClass).toBe(rcaReport.FAILURE_CLASSES.BLOCKED_BY_FOREIGN_WIP);
});

test('writeRcaReport: a blocked_by_foreign_wip_streak verdict points at the sibling job, not "re-run the gate"', async () => {
  const cwd = makeProject();
  const runDir = path.join(tmpHome, 'run-blocked');
  writeRun(runDir, 'blockedslug');
  writePrd(cwd, 'blockedslug');

  const res = await rcaReport.writeRcaReport({
    job: baseJob({ cwd, slug: 'blockedslug' }),
    runDir,
    verdict: 'blocked_by_foreign_wip_streak',
  });

  expect(res.filed).toBe(true);
  expect(res.failureClass).toBe(rcaReport.FAILURE_CLASSES.BLOCKED_BY_FOREIGN_WIP);
  const body = fs.readFileSync(res.path, 'utf8');
  expect(body).toMatch(/sibling job/i);
  expect(body).not.toMatch(/Re-run the acceptance criteria gate/);
});

test('classifyFailure: no NEEDS_HUMAN class remains', () => {
  expect(rcaReport.FAILURE_CLASSES.NEEDS_HUMAN).toBeUndefined();
  expect(rcaReport.classifyFailure({ verdict: 'needs_human', logTail: '' })).not.toBe('needs-human');
});

test('run_commit_not_landed has a label, is never ALREADY_SHIPPED, and routes to investigate', () => {
  const rca = require('../lib/scheduler/rcaReport.cjs');
  expect(rca.VERDICT_LABELS.run_commit_not_landed).toBe('run made a commit that never landed');
  expect(rca.humanVerdict('run_commit_not_landed')).toBe('run made a commit that never landed');
  const cls = rca.classifyFailure({ verdict: 'run_commit_not_landed', logTail: 'the work is already committed, nothing to commit' });
  expect(cls).not.toBe(rca.FAILURE_CLASSES.ALREADY_SHIPPED);
  expect(rca.RECOVERY_ACTIONS[cls]).toBe('investigate');
});

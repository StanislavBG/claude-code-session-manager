/**
 * rcaReport.test.cjs — unit tests for src/main/lib/rcaReport.cjs.
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
const MODULES_TO_RELOAD = ['../lib/rcaReport.cjs', '../config.cjs'];

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
  rcaReport = require('../lib/rcaReport.cjs');
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
    { verdict: 'transcript_errors', logTail: 'while true; do sleep 1; done', expectedClass: rcaReport.FAILURE_CLASSES.STUCK_LOOP },
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

/**
 * rcaFeedbackHook.test.cjs — unit tests for src/main/lib/rcaFeedbackHook.cjs.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/rcaFeedbackHook.test.cjs
 */

'use strict';

import { test, expect, beforeEach, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let tmpHome;
let realHome;
let rcaFeedbackHook;

// config.cjs and rcaFeedbackHook.cjs both bake os.homedir() into top-level
// consts at first require (allowedRoots/WRITE_PREFIXES, SM_REPO_ROOT).
// Node's require cache must be purged per test so each test's tmpHome takes
// effect — vi.resetModules() only resets vitest's ESM graph, not require().
const MODULES_TO_RELOAD = ['../lib/rcaFeedbackHook.cjs', '../config.cjs'];

function purgeRequireCache() {
  for (const m of MODULES_TO_RELOAD) {
    try { delete require.cache[require.resolve(m)]; } catch { /* not loaded yet */ }
  }
}

beforeEach(() => {
  realHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'rca-feedback-hook-test-'));
  process.env.HOME = tmpHome;
  delete process.env.SM_RCA_DISABLE;
  purgeRequireCache();
  rcaFeedbackHook = require('../lib/rcaFeedbackHook.cjs');
  // The session-manager-repo fallback destination must exist as a real dir.
  fs.mkdirSync(path.join(tmpHome, 'Projects', 'session-manager', 'session-manager-operations', 'feedback'), { recursive: true });
});

afterEach(() => {
  process.env.HOME = realHome;
  delete process.env.SM_RCA_DISABLE;
  fs.rmSync(tmpHome, { recursive: true, force: true });
  purgeRequireCache();
});

// ─── helpers ──────────────────────────────────────────────────────────────────

function makeProjectWithInbox(name = 'proj') {
  const cwd = path.join(tmpHome, name);
  fs.mkdirSync(path.join(cwd, 'session-manager-operations', 'feedback'), { recursive: true });
  return cwd;
}

function makeProjectWithoutInbox(name = 'bare-proj') {
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

// ─── dedupe / new-runId ───────────────────────────────────────────────────────

// ─── proposal filing (replaced the feedback-file inbox) ──────────────────────

function readSessions(cwd) {
  const p = path.join(cwd, 'session-manager-operations', 'prompt-sessions', 'active-index.json');
  if (!fs.existsSync(p)) return {};
  return JSON.parse(fs.readFileSync(p, 'utf8')).sessions ?? {};
}

test('fileRcaFeedback: files a PROPOSED Epic carrying the RCA as its opening prompt', async () => {
  const cwd = makeProjectWithInbox();
  const runDir = path.join(tmpHome, 'run1');
  writeRun(runDir, 'testslug');
  writePrd(cwd, 'testslug');

  const res = await rcaFeedbackHook.fileRcaFeedback({ job: baseJob({ cwd }), runDir, verdict: 'transcript_errors' });
  expect(res.filed).toBe(true);
  expect(res.created).toBe(true);

  const sessions = readSessions(cwd);
  const epic = sessions[res.epicId];
  // Nothing may auto-run: the whole point is a human gate.
  expect(epic.status).toBe('proposed');
  expect(epic.tag).toBe('bug');
  expect(epic.goalText).toContain('testslug');
  // Short title for the list, full RCA body for the first prompt.
  expect(epic.goalText.split('\n').length).toBe(1);
  expect(epic.openingPrompt).toContain('Root cause');
  expect(epic.openingPrompt).toContain('prdSlug: testslug');
});

test('fileRcaFeedback: a re-trigger for the same failure joins the proposal instead of duplicating it', async () => {
  const cwd = makeProjectWithInbox();
  const runDir = path.join(tmpHome, 'run1');
  writeRun(runDir, 'testslug');
  writePrd(cwd, 'testslug');
  const job = baseJob({ cwd });

  const first = await rcaFeedbackHook.fileRcaFeedback({ job, runDir, verdict: 'transcript_errors' });
  const second = await rcaFeedbackHook.fileRcaFeedback({ job, runDir, verdict: 'transcript_errors' });

  expect(first.created).toBe(true);
  expect(second.created).toBe(false);
  expect(second.epicId).toBe(first.epicId);
  expect(Object.keys(readSessions(cwd)).length).toBe(1);
});

test('fileRcaFeedback: a different verdict for the same slug is its own proposal', async () => {
  const cwd = makeProjectWithInbox();
  const runDir = path.join(tmpHome, 'run1');
  writeRun(runDir, 'testslug');
  writePrd(cwd, 'testslug');

  const a = await rcaFeedbackHook.fileRcaFeedback({ job: baseJob({ cwd }), runDir, verdict: 'transcript_errors' });
  const b = await rcaFeedbackHook.fileRcaFeedback({ job: baseJob({ cwd }), runDir, verdict: 'pass_no_commit' });

  expect(a.epicId).not.toBe(b.epicId);
  expect(Object.keys(readSessions(cwd)).length).toBe(2);
});

test('fileRcaFeedback: files into the job\'s own project, no feedback dir required', async () => {
  const cwd = makeProjectWithoutInbox();
  const runDir = path.join(tmpHome, 'run1');
  writeRun(runDir, 'testslug');

  const res = await rcaFeedbackHook.fileRcaFeedback({ job: baseJob({ cwd }), runDir, verdict: 'transcript_errors' });
  expect(res.filed).toBe(true);
  expect(readSessions(cwd)[res.epicId].status).toBe('proposed');
});

test('fileRcaFeedback: rejects a slug containing path-traversal segments', async () => {
  const cwd = makeProjectWithInbox();
  const runDir = path.join(tmpHome, 'run1');
  fs.mkdirSync(runDir, { recursive: true });

  const res = await rcaFeedbackHook.fileRcaFeedback({ job: baseJob({ cwd, slug: '../../etc/passwd' }), runDir, verdict: 'transcript_errors' });
  expect(res.filed).toBe(false);
  expect(res.reason).toBe('unsafe-slug');
});

// ─── kill-switch ────────────────────────────────────────────────────────────────

test('fileRcaFeedback: SM_RCA_DISABLE=1 skips without writing', async () => {
  process.env.SM_RCA_DISABLE = '1';
  const cwd = makeProjectWithInbox();
  const runDir = path.join(tmpHome, 'run1');
  writeRun(runDir, 'testslug');
  writePrd(cwd, 'testslug');

  const res = await rcaFeedbackHook.fileRcaFeedback({ job: baseJob({ cwd }), runDir, verdict: 'transcript_errors' });
  expect(res.filed).toBe(false);
  expect(res.reason).toBe('disabled');
  expect(fs.readdirSync(path.join(cwd, 'session-manager-operations', 'feedback')).length).toBe(0);
});

// ─── investigation-text enrichment ──────────────────────────────────────────────

test('fileRcaFeedback: investigationText enriches the pending proposal in place', async () => {
  const cwd = makeProjectWithInbox();
  const runDir = path.join(tmpHome, 'run1');
  writeRun(runDir, 'testslug');
  writePrd(cwd, 'testslug');
  const job = baseJob({ cwd });

  const first = await rcaFeedbackHook.fileRcaFeedback({ job, runDir, verdict: 'transcript_errors' });
  expect(first.filed).toBe(true);
  expect(readSessions(cwd)[first.epicId].openingPrompt).not.toContain('## Investigation analysis');

  const second = await rcaFeedbackHook.fileRcaFeedback({
    job, runDir, verdict: 'transcript_errors', investigationText: 'Root cause: forgot to bound the poll loop.',
  });
  expect(second.epicId).toBe(first.epicId);
  expect(second.updated).toBe(true);

  const enriched = readSessions(cwd)[second.epicId];
  expect(enriched.openingPrompt).toContain('## Investigation analysis');
  expect(enriched.openingPrompt).toContain('forgot to bound the poll loop');
  expect(enriched.status).toBe('proposed');
  expect(Object.keys(readSessions(cwd)).length).toBe(1);
});

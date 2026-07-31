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

test('fileRcaFeedback: second call with same (slug, runId) is a no-op', async () => {
  const cwd = makeProjectWithInbox();
  const runDir = path.join(tmpHome, 'run1');
  writeRun(runDir, 'testslug');
  writePrd(cwd, 'testslug');
  const job = baseJob({ cwd });

  const first = await rcaFeedbackHook.fileRcaFeedback({ job, runDir, verdict: 'transcript_errors' });
  expect(first.filed).toBe(true);

  const second = await rcaFeedbackHook.fileRcaFeedback({ job, runDir, verdict: 'transcript_errors' });
  expect(second.filed).toBe(false);
  expect(second.reason).toBe('duplicate');

  const files = fs.readdirSync(path.join(cwd, 'session-manager-operations', 'feedback'));
  expect(files.length).toBe(1);
});

test('fileRcaFeedback: new runId for the same slug files a new RCA', async () => {
  const cwd = makeProjectWithInbox();
  const runDir1 = path.join(tmpHome, 'run1');
  const runDir2 = path.join(tmpHome, 'run2');
  writeRun(runDir1, 'testslug');
  writeRun(runDir2, 'testslug');
  writePrd(cwd, 'testslug');

  const r1 = await rcaFeedbackHook.fileRcaFeedback({ job: baseJob({ cwd, runId: 'run-aaa' }), runDir: runDir1, verdict: 'transcript_errors' });
  const r2 = await rcaFeedbackHook.fileRcaFeedback({ job: baseJob({ cwd, runId: 'run-bbb' }), runDir: runDir2, verdict: 'transcript_errors' });

  expect(r1.filed).toBe(true);
  expect(r2.filed).toBe(true);
  expect(r1.path).not.toBe(r2.path);

  const files = fs.readdirSync(path.join(cwd, 'session-manager-operations', 'feedback'));
  expect(files.length).toBe(2);
});

test('fileRcaFeedback: a duplicate is still detected after /process-feedback archives the file into processed/', async () => {
  const cwd = makeProjectWithInbox();
  const runDir = path.join(tmpHome, 'run1');
  writeRun(runDir, 'testslug');
  writePrd(cwd, 'testslug');
  const job = baseJob({ cwd });

  const first = await rcaFeedbackHook.fileRcaFeedback({ job, runDir, verdict: 'transcript_errors' });
  expect(first.filed).toBe(true);

  const feedbackDir = path.join(cwd, 'session-manager-operations', 'feedback');
  const processedDir = path.join(feedbackDir, 'processed');
  fs.mkdirSync(processedDir, { recursive: true });
  const fileName = path.basename(first.path);
  fs.renameSync(first.path, path.join(processedDir, fileName));

  const second = await rcaFeedbackHook.fileRcaFeedback({ job, runDir, verdict: 'transcript_errors' });
  expect(second.filed).toBe(false);
  expect(second.reason).toBe('duplicate');
  expect(second.path).toBe(path.join(processedDir, fileName));

  expect(fs.existsSync(path.join(feedbackDir, fileName))).toBe(false);
  const liveFiles = fs.readdirSync(feedbackDir).filter((f) => f !== 'processed');
  expect(liveFiles.length).toBe(0);
  expect(fs.readdirSync(processedDir).length).toBe(1);
});

test('fileRcaFeedback: investigationText updates the file in processed/ in place instead of duplicating it in the live dir', async () => {
  const cwd = makeProjectWithInbox();
  const runDir = path.join(tmpHome, 'run1');
  writeRun(runDir, 'testslug');
  writePrd(cwd, 'testslug');
  const job = baseJob({ cwd });

  const first = await rcaFeedbackHook.fileRcaFeedback({ job, runDir, verdict: 'transcript_errors' });
  expect(first.filed).toBe(true);

  const feedbackDir = path.join(cwd, 'session-manager-operations', 'feedback');
  const processedDir = path.join(feedbackDir, 'processed');
  fs.mkdirSync(processedDir, { recursive: true });
  const fileName = path.basename(first.path);
  const processedPath = path.join(processedDir, fileName);
  fs.renameSync(first.path, processedPath);

  const second = await rcaFeedbackHook.fileRcaFeedback({
    job, runDir, verdict: 'transcript_errors', investigationText: 'Root cause: forgot to bound the poll loop.',
  });
  expect(second.filed).toBe(true);
  expect(second.updated).toBe(true);
  expect(second.path).toBe(processedPath);

  const after = fs.readFileSync(processedPath, 'utf8');
  expect(after).toContain('## Investigation analysis');
  expect(fs.existsSync(path.join(feedbackDir, fileName))).toBe(false);
});

// ─── failure-class matching ───────────────────────────────────────────────────

test('classifyFailure: detects stuck-loop from an until/while-true/sleep tail', () => {
  const logTail = ['doing work', 'until curl -s http://x | jq .uptime; do sleep 5; done', 'still waiting'].join('\n');
  expect(rcaFeedbackHook.classifyFailure({ verdict: 'no_verdict_sentinel', logTail })).toBe('stuck-loop');
});

test('classifyFailure: detects post-ac-overrun when work continues well past the last AC checkbox with no PASS', () => {
  const lines = ['- [x] first AC item done', '- [x] last AC item done'];
  for (let i = 0; i < 30; i++) lines.push(`extra post-AC work line ${i}`);
  const logTail = lines.join('\n');
  expect(rcaFeedbackHook.classifyFailure({ verdict: 'no_verdict_sentinel', logTail })).toBe('post-ac-overrun');
});

test('classifyFailure: falls back to uncommitted-changes for that verdict', () => {
  expect(rcaFeedbackHook.classifyFailure({ verdict: 'uncommitted_changes', logTail: 'no special markers here' })).toBe('uncommitted-changes');
});

test('classifyFailure: falls back to no-sentinel for no_verdict_sentinel/pass_no_commit', () => {
  expect(rcaFeedbackHook.classifyFailure({ verdict: 'no_verdict_sentinel', logTail: 'clean tail, no loops' })).toBe('no-sentinel');
  expect(rcaFeedbackHook.classifyFailure({ verdict: 'pass_no_commit', logTail: 'clean tail, no loops' })).toBe('no-sentinel');
});

test('classifyFailure: falls back to transcript-errors for transcript_errors/verify_unavailable', () => {
  expect(rcaFeedbackHook.classifyFailure({ verdict: 'transcript_errors', logTail: 'Traceback (most recent call last)' })).toBe('transcript-errors');
  expect(rcaFeedbackHook.classifyFailure({ verdict: 'verify_unavailable', logTail: 'verifier threw' })).toBe('transcript-errors');
});

test('classifyFailure: unknown verdict with no matching markers falls back to unknown', () => {
  expect(rcaFeedbackHook.classifyFailure({ verdict: 'halt', logTail: 'nothing special' })).toBe('unknown');
});

test('classifyFailure: detects self-queue from a "Launching skill: session-manager-dev:develop" tail', () => {
  const logTail = ['doing setup', 'Launching skill: session-manager-dev:develop', 'skill running'].join('\n');
  expect(rcaFeedbackHook.classifyFailure({ verdict: 'no_verdict_sentinel', logTail })).toBe('self-queue');
});

test('classifyFailure: detects self-queue from a "Launching skill: session-manager-dev:process-feedback" tail', () => {
  const logTail = ['doing setup', 'Launching skill: session-manager-dev:process-feedback', 'skill running'].join('\n');
  expect(rcaFeedbackHook.classifyFailure({ verdict: 'no_verdict_sentinel', logTail })).toBe('self-queue');
});

test('classifyFailure: detects self-queue from a ScheduleWakeup tool_use even when the tail also contains "sleep" (PRD 771 regression)', () => {
  const logTail = [
    'launching background build: eas-cli build --wait',
    'the app will sleep between polls',
    '{"type":"tool_use","name":"ScheduleWakeup","input":{"delaySeconds":600}}',
  ].join('\n');
  expect(rcaFeedbackHook.classifyFailure({ verdict: 'no_verdict_sentinel', logTail })).toBe('self-queue');
});

test('classifyFailure: detects already-shipped from a pass_no_commit tail citing a prior commit', () => {
  const logTail = ['re-verified acceptance criteria', 'this work was already committed in 9cf0384', 'nothing left to change'].join('\n');
  expect(rcaFeedbackHook.classifyFailure({ verdict: 'pass_no_commit', logTail })).toBe('already-shipped');
});

test('classifyFailure: detects already-shipped from a pass_no_commit tail with "nothing new to commit"', () => {
  const logTail = ['checked the diff', 'nothing new to commit for this PRD', 'exiting clean'].join('\n');
  expect(rcaFeedbackHook.classifyFailure({ verdict: 'pass_no_commit', logTail })).toBe('already-shipped');
});

test('classifyFailure: ALREADY_SHIPPED is checked before SELF_QUEUE, so a no_verdict_sentinel tail with both markers classifies as already-shipped', () => {
  const logTail = [
    'Launching skill: session-manager-dev:develop',
    'the acceptance criteria were already implemented',
  ].join('\n');
  expect(rcaFeedbackHook.classifyFailure({ verdict: 'no_verdict_sentinel', logTail })).toBe('already-shipped');
});

test('classifyFailure: pass_no_commit tail with no already-shipped phrasing still falls back to no-sentinel (regression)', () => {
  const logTail = ['ran the tests', 'everything looked fine', 'printed PASS'].join('\n');
  expect(rcaFeedbackHook.classifyFailure({ verdict: 'pass_no_commit', logTail })).toBe('no-sentinel');
});

test('classifyFailure: STUCK_LOOP/POST_AC_OVERRUN reordering does not change classification when no self-queue marker is present', () => {
  const stuckLoopTail = ['doing work', 'until curl -s http://x | jq .uptime; do sleep 5; done', 'still waiting'].join('\n');
  expect(rcaFeedbackHook.classifyFailure({ verdict: 'no_verdict_sentinel', logTail: stuckLoopTail })).toBe('stuck-loop');

  const postAcLines = ['- [x] first AC item done', '- [x] last AC item done'];
  for (let i = 0; i < 30; i++) postAcLines.push(`extra post-AC work line ${i}`);
  const postAcTail = postAcLines.join('\n');
  expect(rcaFeedbackHook.classifyFailure({ verdict: 'no_verdict_sentinel', logTail: postAcTail })).toBe('post-ac-overrun');
});

// ─── AC extraction ─────────────────────────────────────────────────────────────

test('extractAcceptanceCriteria: pulls the section body between the heading and the next heading', () => {
  const body = ['# Goal', '', 'Do the thing.', '', '# Acceptance criteria', '', '- [ ] one', '- [ ] two', '', '# Out of scope', '', '- N/A'].join('\n');
  expect(rcaFeedbackHook.extractAcceptanceCriteria(body)).toBe('- [ ] one\n- [ ] two');
});

test('extractAcceptanceCriteria: returns null when no such heading exists', () => {
  const body = ['# Goal', '', 'Do the thing.'].join('\n');
  expect(rcaFeedbackHook.extractAcceptanceCriteria(body)).toBeNull();
});

// ─── investigation <RCA> block extraction ──────────────────────────────────────

test('extractRcaBlock: pulls plain-text block content', () => {
  const log = 'preamble\n<RCA>\nForgot to bound the poll loop.\n</RCA>\npostamble';
  expect(rcaFeedbackHook.extractRcaBlock(log)).toBe('Forgot to bound the poll loop.');
});

test('extractRcaBlock: unescapes JSON-escaped newlines from a stream-json transcript', () => {
  const log = '{"text":"<RCA>\\nForgot to bound the poll loop.\\nSee scheduler.cjs:1509.\\n</RCA>"}';
  expect(rcaFeedbackHook.extractRcaBlock(log)).toBe('Forgot to bound the poll loop.\nSee scheduler.cjs:1509.');
});

test('extractRcaBlock: returns null when no block is present', () => {
  expect(rcaFeedbackHook.extractRcaBlock('no block here')).toBeNull();
});

// ─── destination resolution ────────────────────────────────────────────────────

test('resolveDestination: uses the job cwd inbox when it exists', () => {
  const cwd = makeProjectWithInbox();
  const dest = rcaFeedbackHook.resolveDestination({ cwd });
  expect(dest.dir).toBe(path.join(cwd, 'session-manager-operations', 'feedback'));
  expect(dest.targetProjectNote).toBeNull();
});

test('resolveDestination: falls back to the session-manager repo inbox when the target has none', () => {
  const cwd = makeProjectWithoutInbox();
  const dest = rcaFeedbackHook.resolveDestination({ cwd });
  expect(dest.dir).toBe(rcaFeedbackHook.SM_REPO_FEEDBACK_DIR);
  expect(dest.targetProjectNote).toContain(cwd);
});

test('fileRcaFeedback: actually writes into the fallback dir when the target inbox is missing', async () => {
  const cwd = makeProjectWithoutInbox();
  const runDir = path.join(tmpHome, 'run1');
  writeRun(runDir, 'testslug');
  writePrd(cwd, 'testslug');

  const res = await rcaFeedbackHook.fileRcaFeedback({ job: baseJob({ cwd }), runDir, verdict: 'transcript_errors' });
  expect(res.filed).toBe(true);
  expect(res.path.startsWith(rcaFeedbackHook.SM_REPO_FEEDBACK_DIR)).toBe(true);
  const content = fs.readFileSync(res.path, 'utf8');
  expect(content).toContain(cwd);
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

test('fileRcaFeedback: investigationText updates the existing RCA instead of duplicating it', async () => {
  const cwd = makeProjectWithInbox();
  const runDir = path.join(tmpHome, 'run1');
  writeRun(runDir, 'testslug');
  writePrd(cwd, 'testslug');
  const job = baseJob({ cwd });

  const first = await rcaFeedbackHook.fileRcaFeedback({ job, runDir, verdict: 'transcript_errors' });
  expect(first.filed).toBe(true);
  const before = fs.readFileSync(first.path, 'utf8');
  expect(before).not.toContain('## Investigation analysis');

  const second = await rcaFeedbackHook.fileRcaFeedback({
    job, runDir, verdict: 'transcript_errors', investigationText: 'Root cause: forgot to bound the poll loop.',
  });
  expect(second.filed).toBe(true);
  expect(second.updated).toBe(true);
  expect(second.path).toBe(first.path);

  const after = fs.readFileSync(second.path, 'utf8');
  expect(after).toContain('## Investigation analysis');
  expect(after).toContain('forgot to bound the poll loop');

  const files = fs.readdirSync(path.join(cwd, 'session-manager-operations', 'feedback'));
  expect(files.length).toBe(1);
});

/**
 * guard-confirm.test.cjs — the tool-risk 'confirm' mark end to end:
 *   - toolRiskMarks.cjs accepts it (and still fails closed on a bad mark),
 *   - argsDigest is a stable sha256 of canonical JSON,
 *   - the guard denies a confirm-marked call in a job and records one request,
 *   - needsYouStore.drainConfirmationRequests posts one Needs-you item and one
 *     job.confirmation_requested event per (tool, digest), deduped.
 *
 * Run: timeout 120 npx vitest run scripts/hooks/__tests__/guard-confirm.test.cjs
 */

'use strict';

import { test, expect, beforeEach, afterEach } from 'vitest';
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const marksLib = require('../../../src/main/lib/claude/toolRiskMarks.cjs');
const { decide } = require('../lib/guard-tool-risk-policy.cjs');

let tmp;
let prevHome;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-confirm-'));
  prevHome = process.env.SM_SCHEDULER_HOME;
  process.env.SM_SCHEDULER_HOME = path.join(tmp, 'sm-home');
});
afterEach(() => {
  if (prevHome === undefined) delete process.env.SM_SCHEDULER_HOME;
  else process.env.SM_SCHEDULER_HOME = prevHome;
  fs.rmSync(tmp, { recursive: true, force: true });
});

function fixture(marks) {
  const homeDir = path.join(tmp, 'home');
  const projectRoot = path.join(tmp, 'proj');
  fs.mkdirSync(path.join(homeDir, '.claude'), { recursive: true });
  fs.mkdirSync(projectRoot, { recursive: true });
  fs.writeFileSync(path.join(homeDir, '.claude', 'tool-risk.json'), JSON.stringify({ version: 1, marks }));
  const requestsFile = path.join(tmp, 'sm-home', marksLib.CONFIRMATION_REQUESTS_FILE);
  return { homeDir, projectRoot, requestsFile };
}

const MARKS = {
  'Bash(npm publish:*)': 'confirm',
  'mcp__gmail__send_email': 'confirm',
  'Bash(git push --force)': 'irreversible',
};

const env = (f, extra = {}) => ({
  SM_SCHEDULER_JOB_SLUG: '3808-test-job',
  SM_SCHEDULER_JOB_EPIC_ID: 'epic-abc',
  SM_PROJECT_ROOT: f.projectRoot,
  ...extra,
});
const decisionOf = (r) => (r.hookSpecificOutput ? r.hookSpecificOutput.permissionDecision : 'allow');
const reasonOf = (r) => r.hookSpecificOutput.permissionDecisionReason;
const readRequests = (file) => (fs.existsSync(file)
  ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  : []);

// ── marks ───────────────────────────────────────────────────────────────────

test("marks: 'confirm' is a valid mark, not a blocking mark; an unknown mark still fails closed", () => {
  expect(marksLib.MARKS).toContain('confirm');
  expect(marksLib.BLOCKING_MARKS.has('confirm')).toBe(false);
  expect(marksLib.validateMarksFile({ version: 1, marks: { 'Bash(npm publish:*)': 'confirm' } })).toEqual({ ok: true });
  const bad = marksLib.validateMarksFile({ version: 1, marks: { 'Bash(npm publish:*)': 'confirmed' } });
  expect(bad.ok).toBe(false);
  expect(bad.error).toMatch(/unknown mark "confirmed"/);
});

test('marks: a compound line holding confirm and irreversible resolves to irreversible', () => {
  const layer = { ok: true, exists: true, marks: MARKS, file: '/x' };
  const hit = marksLib.resolveMark({ tool: 'Bash', input: { command: 'npm publish && git push --force' } }, { system: layer });
  expect(hit.mark).toBe('irreversible');
});

// ── digest ──────────────────────────────────────────────────────────────────

test('argsDigest: sha256 of canonical JSON — key order never changes it, values do', () => {
  const a = marksLib.argsDigest({ command: 'npm publish', description: 'ship', nested: { b: 2, a: [1, { y: 1, x: 2 }] } });
  const b = marksLib.argsDigest({ nested: { a: [1, { x: 2, y: 1 }], b: 2 }, description: 'ship', command: 'npm publish' });
  expect(a).toBe(b);
  expect(a).toMatch(/^[0-9a-f]{64}$/);
  expect(marksLib.argsDigest({ command: 'npm publish --tag next' })).not.toBe(marksLib.argsDigest({ command: 'npm publish' }));
  const canon = '{"command":"npm publish","description":"ship"}';
  expect(marksLib.canonicalJson({ description: 'ship', command: 'npm publish' })).toBe(canon);
  expect(marksLib.argsDigest({ description: 'ship', command: 'npm publish' }))
    .toBe(crypto.createHash('sha256').update(canon).digest('hex'));
  expect(marksLib.argsDigest(undefined)).toBe(marksLib.argsDigest({}));
});

// ── guard ───────────────────────────────────────────────────────────────────

test('guard: a confirm-marked call in a job is denied, naming the pending confirmation, and one request is recorded', () => {
  const f = fixture(MARKS);
  const input = { command: 'npm publish --tag latest' };
  const r = decide({ tool_name: 'Bash', tool_input: input }, env(f), { homeDir: f.homeDir, confirmationRequestsFile: f.requestsFile });
  expect(decisionOf(r)).toBe('deny');
  const digest = marksLib.argsDigest(input);
  expect(reasonOf(r)).toContain('pending confirmation');
  expect(reasonOf(r)).toContain(digest);
  expect(reasonOf(r)).toContain('Bash(npm publish:*)');
  const reqs = readRequests(f.requestsFile);
  expect(reqs).toHaveLength(1);
  expect(reqs[0]).toMatchObject({
    tool: 'Bash', argsDigest: digest, jobSlug: '3808-test-job', epicId: 'epic-abc', cwd: f.projectRoot, rule: 'Bash(npm publish:*)',
  });
});

test('guard: an MCP confirm call records its tool; riskTools clearance lets it run with no request', () => {
  const f = fixture(MARKS);
  const payload = { tool_name: 'mcp__gmail__send_email', tool_input: { to: 'a@example.com' } };
  const denied = decide(payload, env(f), { homeDir: f.homeDir, confirmationRequestsFile: f.requestsFile });
  expect(decisionOf(denied)).toBe('deny');
  expect(readRequests(f.requestsFile)[0]).toMatchObject({ tool: 'mcp__gmail__send_email', argsDigest: marksLib.argsDigest(payload.tool_input) });

  fs.rmSync(f.requestsFile);
  const cleared = decide(payload, env(f, { SM_SCHEDULER_JOB_RISK_TOOLS: JSON.stringify(['mcp__gmail__send_email']) }),
    { homeDir: f.homeDir, confirmationRequestsFile: f.requestsFile });
  expect(decisionOf(cleared)).toBe('allow');
  expect(readRequests(f.requestsFile)).toEqual([]);
});

test('guard: a blocking mark in the same line still wins over confirm and records nothing', () => {
  const f = fixture(MARKS);
  const r = decide({ tool_name: 'Bash', tool_input: { command: 'npm publish && git push --force' } }, env(f),
    { homeDir: f.homeDir, confirmationRequestsFile: f.requestsFile });
  expect(decisionOf(r)).toBe('deny');
  expect(reasonOf(r)).toContain("'irreversible'");
  expect(readRequests(f.requestsFile)).toEqual([]);
});

test('guard: a Task run (no job slug) is denied without a request record', () => {
  const f = fixture(MARKS);
  const r = decide({ tool_name: 'Bash', tool_input: { command: 'npm publish' } },
    { SM_TOOL_RISK_HEADLESS: '1', SM_PROJECT_ROOT: f.projectRoot },
    { homeDir: f.homeDir, confirmationRequestsFile: f.requestsFile });
  expect(decisionOf(r)).toBe('deny');
  expect(reasonOf(r)).toContain('pending confirmation');
  expect(readRequests(f.requestsFile)).toEqual([]);
});

test('guard: an opted-in interactive Terminal session gets the CLI approval prompt (ask)', () => {
  const f = fixture(MARKS);
  fs.mkdirSync(path.join(f.projectRoot, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(f.projectRoot, '.claude', 'tool-risk.json'), JSON.stringify({ version: 1, interactive: true, marks: {} }));
  const r = decide({ tool_name: 'Bash', tool_input: { command: 'npm publish' } }, { SM_PROJECT_ROOT: f.projectRoot },
    { homeDir: f.homeDir, confirmationRequestsFile: f.requestsFile });
  expect(decisionOf(r)).toBe('ask');
  expect(readRequests(f.requestsFile)).toEqual([]);
});

// ── main process: drain → Needs you + Epic event ────────────────────────────

test('drain: one Needs-you item and one job.confirmation_requested event per (tool, digest), deduped', async () => {
  const f = fixture(MARKS);
  const epicId = 'epic-abc';
  const deps = { homeDir: f.homeDir, confirmationRequestsFile: f.requestsFile };
  const call = { tool_name: 'Bash', tool_input: { command: 'npm publish --tag latest' } };
  decide(call, env(f), deps);
  decide(call, env(f, { SM_SCHEDULER_JOB_SLUG: '3809-other-job' }), deps); // same digest from a second job
  decide({ tool_name: 'mcp__gmail__send_email', tool_input: {} }, env(f), deps);
  expect(readRequests(f.requestsFile)).toHaveLength(3);

  const store = require('../../../src/main/lib/feedback-remote/needsYouStore.cjs');
  const { readEpicEvents } = require('../../../src/main/lib/epic/epicEventLog.cjs');
  const first = await store.drainConfirmationRequests({ file: f.requestsFile });
  expect(first).toEqual({ read: 3, posted: 3, created: 2 });
  expect(fs.existsSync(f.requestsFile)).toBe(false);

  const items = await store.listNeedsYou({ app: store.CONFIRM_APP });
  expect(items).toHaveLength(2);
  const digest = marksLib.argsDigest(call.tool_input);
  const bashItem = items.find((it) => it.id === store.confirmationItemId('Bash', digest));
  expect(bashItem).toMatchObject({ status: 'open', epicId, cwd: f.projectRoot });
  expect(bashItem.title).toContain('npm publish --tag latest');
  expect(bashItem.why).toContain(digest);

  const events = await readEpicEvents(f.projectRoot, epicId, { kinds: ['job.confirmation_requested'] });
  const list = Array.isArray(events) ? events : events.events;
  expect(list).toHaveLength(2);
  expect(list.find((e) => e.tool === 'Bash')).toMatchObject({ argsDigest: digest, jobSlug: '3808-test-job' });
  const needsInput = await readEpicEvents(f.projectRoot, epicId, { kinds: ['job.needs_input'] });
  expect(Array.isArray(needsInput) ? needsInput : needsInput.events).toHaveLength(0);

  // The same request again (a re-queued job hitting it again) adds nothing.
  decide(call, env(f), deps);
  const second = await store.drainConfirmationRequests({ file: f.requestsFile });
  expect(second).toEqual({ read: 1, posted: 1, created: 0 });
  expect(await store.listNeedsYou({ app: store.CONFIRM_APP })).toHaveLength(2);
  const after = await readEpicEvents(f.projectRoot, epicId, { kinds: ['job.confirmation_requested'] });
  expect(Array.isArray(after) ? after : after.events).toHaveLength(2);
});

test('drain: a missing file is a no-op and a bad line is dropped without stopping the rest', async () => {
  const f = fixture(MARKS);
  const store = require('../../../src/main/lib/feedback-remote/needsYouStore.cjs');
  expect(await store.drainConfirmationRequests({ file: f.requestsFile })).toEqual({ read: 0, posted: 0, created: 0 });
  fs.mkdirSync(path.dirname(f.requestsFile), { recursive: true });
  fs.writeFileSync(f.requestsFile, [
    'not json',
    JSON.stringify({ tool: 'Bash', argsDigest: 'short' }),
    JSON.stringify({ tool: 'Bash', argsDigest: marksLib.argsDigest({ command: 'npm publish' }), jobSlug: 'j' }),
  ].join('\n'));
  expect(await store.drainConfirmationRequests({ file: f.requestsFile })).toEqual({ read: 3, posted: 1, created: 1 });
  const [item] = await store.listNeedsYou({ app: store.CONFIRM_APP });
  expect(item.epicId).toBeUndefined();
});

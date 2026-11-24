/**
 * toolUseHumanMessageEvents.test.cjs — the job.tool_use emitter (scheduler job
 * stream-json log → createJobToolUseEmitter) and the human.message emitter
 * (chatRunner.run, the path chat_send_prompt also reaches through chat:run).
 * Covers the 200-char cap, secret redaction, byte offsets, once-per-prompt and
 * a failing append that is logged, never thrown.
 *
 * Run: timeout 120 npx vitest run src/main/lib/epic/__tests__/toolUseHumanMessageEvents.test.cjs
 */
'use strict';

import { test, expect, beforeEach, afterEach, vi } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const epicEventLog = require('../epicEventLog.cjs');
const {
  createJobToolUseEmitter, summarizeToolUse, humanMessageSummary, EVENT_SUMMARY_MAX,
} = require('../../toolUseClassify.cjs');

const EPIC = 'aaaaaaaa-bbbb-4ccc-8ddd-000000003944';
let cwd;
let schedHome;
let prevHome;

beforeEach(() => {
  epicEventLog._resetForTests();
  cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sm-tooluse-')));
  schedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-tooluse-home-'));
  prevHome = process.env.SM_SCHEDULER_HOME;
  process.env.SM_SCHEDULER_HOME = schedHome;
  require('../../../config.cjs').addAllowedRoot(cwd);
});

afterEach(() => {
  vi.restoreAllMocks();
  if (prevHome === undefined) delete process.env.SM_SCHEDULER_HOME;
  else process.env.SM_SCHEDULER_HOME = prevHome;
  fs.rmSync(cwd, { recursive: true, force: true });
  fs.rmSync(schedHome, { recursive: true, force: true });
});

const events = async (kinds) => (await epicEventLog.readEpicEvents(cwd, EPIC, { kinds })).events;
const waitFor = async (fn, tries = 200) => {
  for (let i = 0; i < tries; i++) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 10));
  }
  return null;
};

const assistantLine = (blocks) => JSON.stringify({ type: 'assistant', message: { content: blocks } }) + '\n';

// ── job.tool_use ─────────────────────────────────────────────────────────

test('each tool_use block of an Epic job appends job.tool_use { slug, tool, summary, transcriptOffset }', async () => {
  const logPath = path.join(cwd, 'job.log');
  const banner = '[scheduler] starting 3944 at now\n\n';
  const line1 = assistantLine([
    { type: 'text', text: 'reading' },
    { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/x/a.cjs' } },
    { type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'npm test' } },
  ]);
  const line2 = assistantLine([{ type: 'tool_use', id: 't3', name: 'Write', input: { file_path: '/x/b.cjs', content: 'FULL BODY '.repeat(500) } }]);
  fs.writeFileSync(logPath, banner + line1);

  const emitter = createJobToolUseEmitter({
    job: { slug: '3944-x', epicId: EPIC, cwd }, logPath, appendEvent: epicEventLog.appendEpicEvent,
  });
  expect(emitter).not.toBeNull();
  emitter.poll();
  // A torn half-line is held until it completes.
  const half = Math.floor(line2.length / 2);
  fs.appendFileSync(logPath, line2.slice(0, half));
  emitter.poll();
  fs.appendFileSync(logPath, line2.slice(half, -1)); // final line without newline
  emitter.flush();

  const evs = await waitFor(async () => { const e = await events(['job.tool_use']); return e.length === 3 ? e : null; });
  expect(evs).not.toBeNull();
  const off1 = Buffer.byteLength(banner);
  const off2 = off1 + Buffer.byteLength(line1);
  expect(evs.map((e) => [e.slug, e.tool, e.summary, e.transcriptOffset])).toEqual([
    ['3944-x', 'Read', 'Read: /x/a.cjs', off1],
    ['3944-x', 'Bash', 'Bash: npm test', off1],
    ['3944-x', 'Write', 'Write: /x/b.cjs', off2],
  ]);
  // Never the full input.
  expect(JSON.stringify(evs)).not.toContain('FULL BODY');
});

test('a job without an epicId emits nothing', () => {
  const append = vi.fn();
  expect(createJobToolUseEmitter({ job: { slug: 's', cwd }, logPath: path.join(cwd, 'none.log'), appendEvent: append })).toBeNull();
});

test('tool summary is capped at 200 chars and redacts secret-shaped env values', () => {
  const long = summarizeToolUse({ name: 'Bash', input: { command: `echo ${'x'.repeat(1000)}` } });
  expect(long.length).toBeLessThanOrEqual(EVENT_SUMMARY_MAX);
  expect(EVENT_SUMMARY_MAX).toBe(200);

  const s = summarizeToolUse({ name: 'Bash', input: { command: 'GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123 API_KEY="hunter2secret" curl -H "Authorization: Bearer abcdef1234567890xyz" sk-ant-REALKEY1234567890' } });
  expect(s).not.toMatch(/ghp_abcdef|hunter2secret|abcdef1234567890xyz|REALKEY/);
  expect(s).toContain('[redacted]');
  expect(s.length).toBeLessThanOrEqual(200);
});

test('a failing append is logged, never thrown (sync throw and rejection)', async () => {
  const logPath = path.join(cwd, 'job.log');
  fs.writeFileSync(logPath, assistantLine([
    { type: 'tool_use', name: 'Read', input: { file_path: '/a' } },
    { type: 'tool_use', name: 'Read', input: { file_path: '/b' } },
  ]));
  let n = 0;
  const appendEvent = () => {
    n += 1;
    if (n === 1) throw new Error('sync boom');
    return Promise.reject(new Error('async boom'));
  };
  const logged = [];
  const emitter = createJobToolUseEmitter({ job: { slug: 's', epicId: EPIC, cwd }, logPath, appendEvent, logError: (m) => logged.push(m) });
  expect(() => emitter.flush()).not.toThrow();
  await waitFor(() => logged.length === 2);
  expect(logged).toHaveLength(2);
  expect(logged[0]).toMatch(/job\.tool_use append failed.*sync boom/);
  expect(logged[1]).toMatch(/async boom/);
});

// ── human.message ────────────────────────────────────────────────────────

test('humanMessageSummary: char count + ≤200-char redacted excerpt', () => {
  const prompt = `PASSWORD=supersecret1 ${'word '.repeat(200)}`;
  const s = humanMessageSummary(prompt);
  expect(s.chars).toBe(prompt.length);
  expect(s.excerpt.length).toBeLessThanOrEqual(200);
  expect(s.excerpt).not.toContain('supersecret1');
});

test('chatRunner.run appends human.message once per human prompt; scheduler prompts and failures never break the send', async () => {
  const cr = require('../../../chatRunner.cjs');
  cr.__resetQueueForTests();
  const ran = [];
  cr.__setExecutor((job) => { ran.push(job.prompt); return Promise.resolve(); });
  try {
    const prompt = `please ${'do it '.repeat(100)}`;
    cr.run({ tabId: EPIC, sessionId: EPIC, prompt, cwd, resume: false, origin: 'human' });
    const evs = await waitFor(async () => { const e = await events(['human.message']); return e.length ? e : null; });
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({ kind: 'human.message', chars: prompt.length });
    expect(evs[0].excerpt.length).toBeLessThanOrEqual(200);
    expect(evs[0].excerpt.startsWith('please do it')).toBe(true);
    await waitFor(() => ran.length === 1);

    // A scheduler-originated prompt is not a human message.
    cr.run({ tabId: EPIC, sessionId: EPIC, prompt: 'auto', cwd, resume: true, origin: 'scheduler' });
    await waitFor(() => ran.length === 2);
    await new Promise((r) => setTimeout(r, 50));
    expect(await events(['human.message'])).toHaveLength(1);

    // A failing append is logged and the run still proceeds.
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(epicEventLog, 'appendEpicEvent').mockImplementation(() => Promise.reject(new Error('disk full')));
    expect(() => cr.run({ tabId: EPIC, sessionId: EPIC, prompt: 'next', cwd, resume: true, origin: 'human' })).not.toThrow();
    await waitFor(() => ran.length === 3);
    expect(ran).toEqual([prompt, 'auto', 'next']);
    await waitFor(() => err.mock.calls.some((c) => String(c[0]).includes('epic event append failed')));
    expect(err.mock.calls.some((c) => String(c[0]).includes('epic event append failed') && c[1] === 'human.message')).toBe(true);
  } finally {
    cr.__setExecutor(null);
    cr.__resetQueueForTests();
  }
});

/**
 * toolUseHumanMessageEvents.test.cjs — the job.tool_use emitter (scheduler job
 * stream-json log → createJobToolUseEmitter) and the message emitters in
 * chatRunner.run. The rule: a desktop composer prompt (origin "human") logs
 * human.message { via: 'desktop' }; an external send tagged at its source by
 * enqueueExternalPrompt's relay marker (noted per tab + prompt, TTL, consumed
 * once by run()) logs human.message { via: 'web-remote' } for the phone and
 * external.message { via: 'admin-api' } for POST /admin/chat/send-prompt.
 * Untagged external, scheduler, inbound-proposal, no-origin and boot-recovery
 * runs log nothing. Also covers the 200-char cap, secret redaction, byte
 * offsets, once-per-prompt and a failing append that is logged, never thrown.
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

test('human.message is logged only for origin "human": none for no origin, scheduler, or a boot-recovery re-send', async () => {
  const cr = require('../../../chatRunner.cjs');
  const { recoverInflightTurns, CONTINUE_PROMPT } = require('../../chatBootRecovery.cjs');
  cr.__resetQueueForTests();
  const ran = [];
  cr.__setExecutor((job) => { ran.push(job.prompt); return Promise.resolve(); });
  const appends = [];
  const real = epicEventLog.appendEpicEvent;
  vi.spyOn(epicEventLog, 'appendEpicEvent').mockImplementation((...args) => {
    const p = real(...args);
    appends.push(p);
    return p;
  });
  const humanEvents = async () => { await Promise.all(appends); return events(['human.message']); };
  try {
    cr.run({ tabId: EPIC, sessionId: EPIC, prompt: 'typed by a human', cwd, resume: false, origin: 'human' });
    expect(await humanEvents()).toHaveLength(1);

    cr.run({ tabId: EPIC, sessionId: EPIC, prompt: 'no origin', cwd, resume: true });
    cr.run({ tabId: EPIC, sessionId: EPIC, prompt: 'auto', cwd, resume: true, origin: 'scheduler' });

    // Boot recovery re-sends an interrupted human turn with that turn's origin.
    const ended = [];
    const ledger = {
      list: async () => [{ sessionId: EPIC, tabId: EPIC, cwd, pid: 999999, origin: 'human' }],
      end: async (id) => { ended.push(id); },
      recoveredMap: async () => ({}),
      markRecovered: async () => {},
    };
    const { results } = await recoverInflightTurns({
      ledger, run: cr.run, pidAlive: () => false, sessionTurnState: async () => 'unfinished',
      agentCliOf: () => null, log: () => {},
    });
    expect(results).toContainEqual({ sessionId: EPIC, outcome: 'rerun' });

    await waitFor(() => ran.length === 4);
    expect(ran).toEqual(['typed by a human', 'no origin', 'auto', CONTINUE_PROMPT]);
    const evs = await humanEvents();
    expect(evs).toHaveLength(1);
    expect(evs[0].excerpt.startsWith('typed by a human')).toBe(true);
  } finally {
    cr.__setExecutor(null);
    cr.__resetQueueForTests();
  }
});

// ── relay-tagged external sends ─────────────────────────────────────────

const fakeWindow = () => ({
  isDestroyed: () => false,
  webContents: { isDestroyed: () => false, send: () => {} },
});

function withRunner() {
  const cr = require('../../../chatRunner.cjs');
  cr.__resetQueueForTests();
  const ran = [];
  cr.__setExecutor((job) => { ran.push(job.prompt); return Promise.resolve(); });
  cr.attachWindow(fakeWindow());
  const appends = [];
  const real = epicEventLog.appendEpicEvent;
  vi.spyOn(epicEventLog, 'appendEpicEvent').mockImplementation((...args) => {
    const p = real(...args);
    appends.push(p);
    return p;
  });
  const msgEvents = async () => { await Promise.all(appends); return events(['human.message', 'external.message']); };
  const done = () => { cr.attachWindow(null); cr.__setExecutor(null); cr.__resetQueueForTests(); };
  return { cr, ran, msgEvents, done };
}

test('EVENT_KINDS includes external.message', () => {
  expect(epicEventLog.EVENT_KINDS).toContain('external.message');
  expect(epicEventLog.EVENT_KINDS).toContain('human.message');
});

test('desktop, phone and admin-API prompts log their kind + via; each relay tag is consumed once', async () => {
  const { cr, ran, msgEvents, done } = withRunner();
  try {
    cr.run({ tabId: EPIC, sessionId: EPIC, prompt: 'typed', cwd, resume: false, origin: 'human' });

    void cr.enqueueExternalPrompt(EPIC, 'from phone', { relay: 'web-remote' });
    cr.run({ tabId: EPIC, sessionId: EPIC, prompt: 'from phone', cwd, resume: true, origin: 'external' });

    void cr.enqueueExternalPrompt(EPIC, 'from agent', { relay: 'admin-api' });
    cr.run({ tabId: EPIC, sessionId: EPIC, prompt: 'from agent', cwd, resume: true, origin: 'external' });

    // Consumed once: the same text again, untagged, logs nothing.
    cr.run({ tabId: EPIC, sessionId: EPIC, prompt: 'from phone', cwd, resume: true, origin: 'external' });
    cr.run({ tabId: EPIC, sessionId: EPIC, prompt: 'from agent', cwd, resume: true, origin: 'external' });

    await waitFor(() => ran.length === 5);
    const evs = await msgEvents();
    expect(evs.map((e) => [e.kind, e.via, e.excerpt])).toEqual([
      ['human.message', 'desktop', 'typed'],
      ['human.message', 'web-remote', 'from phone'],
      ['external.message', 'admin-api', 'from agent'],
    ]);
  } finally {
    done();
  }
});

test('a relay tag is keyed by tab + prompt and expires after its TTL', async () => {
  const { cr, ran, msgEvents, done } = withRunner();
  try {
    // Another tab's tag never matches this tab.
    void cr.enqueueExternalPrompt('other-tab', 'hello', { relay: 'web-remote' });
    cr.run({ tabId: EPIC, sessionId: EPIC, prompt: 'hello', cwd, resume: false, origin: 'external' });
    // A different prompt never matches.
    void cr.enqueueExternalPrompt(EPIC, 'one text', { relay: 'admin-api' });
    cr.run({ tabId: EPIC, sessionId: EPIC, prompt: 'another text', cwd, resume: true, origin: 'external' });
    // An expired tag is dropped.
    const t0 = Date.now();
    void cr.enqueueExternalPrompt(EPIC, 'late', { relay: 'web-remote' });
    const now = vi.spyOn(Date, 'now').mockReturnValue(t0 + 7 * 60 * 60 * 1000);
    cr.run({ tabId: EPIC, sessionId: EPIC, prompt: 'late', cwd, resume: true, origin: 'external' });
    now.mockRestore();
    // An unknown relay name is never noted.
    void cr.enqueueExternalPrompt(EPIC, 'bogus', { relay: 'nope' });
    cr.run({ tabId: EPIC, sessionId: EPIC, prompt: 'bogus', cwd, resume: true, origin: 'external' });

    await waitFor(() => ran.length === 4);
    expect(await msgEvents()).toHaveLength(0);
  } finally {
    done();
  }
});

test('untagged external, scheduler, inbound-proposal, no-origin and boot-recovery runs log nothing', async () => {
  const { cr, ran, msgEvents, done } = withRunner();
  const { recoverInflightTurns } = require('../../chatBootRecovery.cjs');
  try {
    cr.run({ tabId: EPIC, sessionId: EPIC, prompt: 'untagged external', cwd, resume: false, origin: 'external' });
    cr.run({ tabId: EPIC, sessionId: EPIC, prompt: 'auto', cwd, resume: true, origin: 'scheduler' });
    // A scheduler send through enqueueExternalPrompt is re-identified as scheduler, even with a relay.
    void cr.enqueueExternalPrompt(EPIC, 'sched via enqueue', { origin: 'scheduler', relay: 'admin-api' });
    cr.run({ tabId: EPIC, sessionId: EPIC, prompt: 'sched via enqueue', cwd, resume: true, origin: 'external' });
    cr.run({ tabId: EPIC, sessionId: EPIC, prompt: 'proposal', cwd, resume: true, origin: 'inbound-proposal' });
    cr.run({ tabId: EPIC, sessionId: EPIC, prompt: 'no origin', cwd, resume: true });
    // A tagged prompt on a boot-recovery re-send is still not logged.
    void cr.enqueueExternalPrompt(EPIC, 'recovered', { relay: 'web-remote' });
    cr.run({ tabId: EPIC, sessionId: EPIC, prompt: 'recovered', cwd, resume: true, origin: 'external', bootRecovery: true });
    // Real boot recovery of an interrupted phone turn.
    const ledger = {
      list: async () => [{ sessionId: EPIC, tabId: EPIC, cwd, pid: 999999, origin: 'external' }],
      end: async () => {},
      recoveredMap: async () => ({}),
      markRecovered: async () => {},
    };
    await recoverInflightTurns({
      ledger, run: cr.run, pidAlive: () => false, sessionTurnState: async () => 'unfinished',
      agentCliOf: () => null, log: () => {},
    });
    await waitFor(() => ran.length === 7);
    expect(ran).toHaveLength(7);
    expect(await msgEvents()).toHaveLength(0);
  } finally {
    done();
  }
});

test('POST /admin/chat/send-prompt tags its send admin-api and never stamps origin human', async () => {
  const { Readable } = require('node:stream');
  const { cr, ran, msgEvents, done } = withRunner();
  const routes = new Map();
  cr.registerAdminRoute({ registerRoute: (m, u, h) => routes.set(`${m} ${u}`, h) });
  const sent = [];
  cr.attachWindow({ isDestroyed: () => false, webContents: { isDestroyed: () => false, send: (c, p) => sent.push({ c, p }) } });
  try {
    const req = Readable.from([Buffer.from(JSON.stringify({ tabId: EPIC, prompt: 'agent says hi' }))]);
    const res = { writeHead: () => {}, end: () => {} };
    const handled = routes.get('POST /admin/chat/send-prompt')(req, res);
    await waitFor(() => sent.length === 1);
    expect(sent[0].p).not.toHaveProperty('origin');
    cr.run({ tabId: EPIC, sessionId: EPIC, prompt: 'agent says hi', cwd, resume: false, origin: 'external' });
    await waitFor(() => ran.length === 1);
    const evs = await msgEvents();
    expect(evs.map((e) => [e.kind, e.via])).toEqual([['external.message', 'admin-api']]);
    cr.settleExternalSend?.({ requestId: sent[0].p.requestId, disposition: 'sent' });
    void handled;
  } finally {
    done();
  }
});

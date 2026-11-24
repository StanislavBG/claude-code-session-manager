/**
 * slotsRoute.test.cjs — GET/POST /admin/scheduler/slots (lib/scheduler/slotsRoute.cjs)
 * over the REAL sessionSlots (tmp SM_SCHEDULER_HOME) and the REAL
 * humanPromptLedger; project context, audit and clock injected.
 *
 * Run: timeout 300 npx vitest run src/main/lib/scheduler/__tests__/slotsRoute.test.cjs
 */
'use strict';

import { test, expect, describe, beforeEach, afterEach, vi } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const sessionSlots = require('../sessionSlots.cjs');
const humanPromptLedger = require('../../feedback-remote/humanPromptLedger.cjs');
const { registerSlotsRoute, quoteNamesSlots, promptSentenceNamesSlots } = require('../slotsRoute.cjs');

const SID = 'chat-session-slots';
// The owner's own sentence: it mentions sessions, the limit and 10, but asks
// for no change — it must authorize no cap.
const OWNER_SENTENCE = 'lets see first 10 sessions chugging and then we will move the limit via the mcp';
const QUOTE = 'ok, raise the session limit to 10';

function fakeReq(body) {
  const req = new EventEmitter();
  req.setTimeout = () => {};
  req.destroy = () => {};
  setImmediate(() => {
    if (body !== undefined) req.emit('data', Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)));
    req.emit('end');
  });
  return req;
}

function fakeRes() {
  const res = new EventEmitter();
  res.status = null;
  res.body = null;
  res.writeHead = (s) => { res.status = s; };
  res.end = (b) => { res.body = JSON.parse(b); };
  return res;
}

let schedHome;
let prevSchedHome;
let prevEnvSlots;
let audit;
let clock;
let handlers;

async function call(method, body) {
  const res = fakeRes();
  await handlers.get(`${method} /admin/scheduler/slots`)(fakeReq(body), res);
  return res;
}

beforeEach(() => {
  schedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-slotsroute-sched-'));
  prevSchedHome = process.env.SM_SCHEDULER_HOME;
  prevEnvSlots = process.env.SM_SESSION_SLOTS;
  process.env.SM_SCHEDULER_HOME = schedHome;
  delete process.env.SM_SESSION_SLOTS;
  sessionSlots.__resetForTests();
  humanPromptLedger._resetForTests();
  audit = vi.fn();
  clock = Date.now() + 60_000;
  handlers = new Map();
  registerSlotsRoute({ registerRoute: (m, p, h) => handlers.set(`${m} ${p}`, h) }, {
    resolveProjectContext: () => ({ cwd: '/p', epicId: 'epic-1', epicCwd: '/p', source: 'epic-index' }),
    appendAuditEvent: audit,
    now: () => clock,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  sessionSlots.__resetForTests();
  humanPromptLedger._resetForTests();
  if (prevSchedHome === undefined) delete process.env.SM_SCHEDULER_HOME;
  else process.env.SM_SCHEDULER_HOME = prevSchedHome;
  if (prevEnvSlots === undefined) delete process.env.SM_SESSION_SLOTS;
  else process.env.SM_SESSION_SLOTS = prevEnvSlots;
});

function expectNoWrite() {
  expect(sessionSlots.totalSlots()).toBe(sessionSlots.DEFAULT_SLOTS);
  expect(fs.existsSync(path.join(schedHome, 'session-slots-config.json'))).toBe(false);
  expect(audit).not.toHaveBeenCalled();
}

describe('quoteNamesSlots', () => {
  test.each(Array.from({ length: 33 }, (_, n) => [n]))('the owner sentence authorizes no cap (%i)', (n) => {
    expect(quoteNamesSlots(OWNER_SENTENCE, n)).toBe(false);
  });

  // [quote, cap, accepted] — only the strict sentence form authorizes.
  test.each([
    // accepted: the strict sentence form
    ['raise the limit to 14', 14, true],
    ['Please set the session limit to 12.', 12, true],
    ['ok, lower the cap to 6 slots', 6, true],
    [QUOTE, 10, true],
    ['set the slots to 12', 12, true],
    ['bump our parallel limit to 20 sessions', 20, true],
    ['Now   INCREASE the slot cap to 8!', 8, true],
    ['change the cap to 0', 0, true],
    ['thanks. reduce the limit to 4', 4, true],
    ['I cant wait\nset the slots to 12', 12, true],
    // refused: anything after the number, or a question
    ['raise the limit to 14 (pct)', 14, false],
    ['raise the limit to 14?', 14, false],
    ['raise the limit to 14 percent', 14, false],
    ['raise the limit to 14%', 14, false],
    ['raise the limit to 14 parallel sessions', 14, false],
    ['raise the limit to 14 please', 14, false],
    ['raise the limit to 14?"', 14, false],
    // refused: anything before the verb that is not a lead-in
    ['will you raise the limit to 14', 14, false],
    ['I want to raise the limit to 14', 14, false],
    ["don't raise the limit to 14", 14, false],
    ['I cant wait, set the slots to 12', 12, false],
    ['ok now raise the session limit to 10', 10, false],
    // refused: not the form at all
    ['make it 16 parallel sessions', 16, false],
    [OWNER_SENTENCE, 10, false],
    ['the limit was set to 10 yesterday', 10, false],
    ['set it to 10 please', 10, false],
    ['raise the limit to fourteen', 14, false],
    ['raise the limit. to 14', 14, false],
    // refused: wrong / ambiguous number
    ['raise the session limit to 10', 12, false],
    ['raise the session limit to 100', 10, false],
    ['raise the limit to 14.5', 14, false],
    ['raise the limit to 014', 14, false],
    // refused: not a string / not an integer
    [42, 42, false],
    ['raise the limit to 14', 14.5, false],
  ])('%j / %s → %s', (q, n, want) => {
    expect(quoteNamesSlots(q, n)).toBe(want);
  });
});

describe('promptSentenceNamesSlots', () => {
  // [human prompt, quote, cap, accepted] — the whole prompt sentence around the quote must be the form.
  test.each([
    ['Thanks. Raise the limit to 14.', 'raise the limit to 14', 14, true],
    ['raise the limit to 14', 'raise the limit to 14', 14, true],
    ['thanks.\n  ok, RAISE   the limit to 14\nbye', 'ok, raise the limit to 14', 14, true],
    ['hi. thanks. reduce the limit to 4', 'thanks. reduce the limit to 4', 4, true],
    ["don't raise the limit to 14", 'raise the limit to 14', 14, false],
    ['raise the limit to 14?', 'raise the limit to 14', 14, false],
    ['will you raise the limit to 14', 'raise the limit to 14', 14, false],
    ['raise the limit to 14 (pct)', 'raise the limit to 14', 14, false],
    ['raise the limit to 14.5', 'raise the limit to 14', 14, false],
    ['raise the limit to 14 please', 'raise the limit to 14', 14, false],
    ['raise the limit to 14', 'raise the limit to 14', 12, false],
    // a sentence the quote only partly overlaps never authorizes
    ['raise the limit to 14. it is fine', 'limit to 14. it is fine', 14, false],
    ['raise the limit to 14', 'not in the prompt at all', 14, false],
    [null, 'raise the limit to 14', 14, false],
  ])('%j / %j / %s → %s', (p, q, n, want) => {
    expect(promptSentenceNamesSlots(p, q, n)).toBe(want);
  });
});

describe('GET /admin/scheduler/slots', () => {
  test('returns cap, bounds, in-use and available from sessionSlots', async () => {
    const tok = sessionSlots.acquire('test:holder');
    expect(tok).toBeTruthy();
    const res = await call('GET');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      cap: sessionSlots.DEFAULT_SLOTS,
      min: sessionSlots.MIN_SLOTS,
      max: sessionSlots.MAX_SLOTS,
      inUse: 1,
      available: sessionSlots.available(),
    });
    expect(res.body.min).toBe(0);
    expect(res.body.max).toBe(32);
  });
});

describe('POST /admin/scheduler/slots', () => {
  test('a verified quote changes the cap and writes one audit event', async () => {
    const at = clock - 5_000;
    humanPromptLedger.recordHumanPrompt(SID, `Thanks.\n${QUOTE}. thanks`, at);
    const setCap = vi.spyOn(sessionSlots, 'setCap');
    const res = await call('POST', { cap: 10, quote: QUOTE, originClaudeSessionId: SID });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, from: sessionSlots.DEFAULT_SLOTS, to: 10 });
    expect(setCap).toHaveBeenCalledWith(10);
    expect(sessionSlots.totalSlots()).toBe(10);
    expect(JSON.parse(fs.readFileSync(path.join(schedHome, 'session-slots-config.json'), 'utf8'))).toEqual({ cap: 10 });
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledWith('slot_cap_changed', {
      from: sessionSlots.DEFAULT_SLOTS,
      to: 10,
      epicId: 'epic-1',
      quote: QUOTE,
      promptAt: new Date(at).toISOString(),
    });
  });

  test('403 human_request_unverified when the quote is not in a human prompt', async () => {
    humanPromptLedger.recordHumanPrompt('other-session', QUOTE, clock - 1_000);
    const res = await call('POST', { cap: 10, quote: QUOTE, originClaudeSessionId: SID });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('human_request_unverified');
    expectNoWrite();
  });

  test('403 quote_does_not_name_slots when the quote lacks the limit word', async () => {
    const q = 'please bump it up to 10 right now, thanks';
    humanPromptLedger.recordHumanPrompt(SID, q, clock - 1_000);
    const res = await call('POST', { cap: 10, quote: q, originClaudeSessionId: SID });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('quote_does_not_name_slots');
    expect(res.body.reason).toContain("say 'raise the limit to 10'");
    expectNoWrite();
  });

  test('403 quote_does_not_name_slots for the owner sentence, even though it names 10 sessions and the limit', async () => {
    humanPromptLedger.recordHumanPrompt(SID, OWNER_SENTENCE, clock - 1_000);
    const res = await call('POST', { cap: 10, quote: OWNER_SENTENCE, originClaudeSessionId: SID });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('quote_does_not_name_slots');
    expectNoWrite();
  });

  test.each([
    ["don't raise the limit to 14"],
    ['raise the limit to 14?'],
    ['will you raise the limit to 14'],
    ['raise the limit to 14 (pct)'],
  ])('403 quote_does_not_name_slots when the human prompt is %j, though the quote alone is the form', async (prompt) => {
    humanPromptLedger.recordHumanPrompt(SID, prompt, clock - 1_000);
    const res = await call('POST', { cap: 14, quote: 'raise the limit to 14', originClaudeSessionId: SID });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('quote_does_not_name_slots');
    expect(res.body.reason).toContain('[please|ok|okay|so|now|then]');
    expect(res.body.reason).toContain('a comma only right after the lead-in word');
    expectNoWrite();
  });

  test('the quote authorizes 14 when the human prompt is "Thanks. Raise the limit to 14."', async () => {
    humanPromptLedger.recordHumanPrompt(SID, 'Thanks. Raise the limit to 14.', clock - 1_000);
    const res = await call('POST', { cap: 14, quote: 'raise the limit to 14', originClaudeSessionId: SID });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, from: sessionSlots.DEFAULT_SLOTS, to: 14 });
    expect(sessionSlots.totalSlots()).toBe(14);
    expect(audit).toHaveBeenCalledTimes(1);
  });

  test('the latest matching human prompt decides: a later "don\'t raise the limit to 14" refuses', async () => {
    humanPromptLedger.recordHumanPrompt(SID, 'raise the limit to 14', clock - 2_000);
    humanPromptLedger.recordHumanPrompt(SID, "don't raise the limit to 14", clock - 1_000);
    const res = await call('POST', { cap: 14, quote: 'raise the limit to 14', originClaudeSessionId: SID });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('quote_does_not_name_slots');
    expect(res.body.reason).toContain('nothing else in the sentence');
    expect(res.body.reason).not.toContain('nothing before or after it');
    expectNoWrite();
  });

  test('the latest matching human prompt decides: a later "raise the limit to 14" authorizes 14', async () => {
    humanPromptLedger.recordHumanPrompt(SID, "don't raise the limit to 14", clock - 2_000);
    humanPromptLedger.recordHumanPrompt(SID, 'raise the limit to 14', clock - 1_000);
    const res = await call('POST', { cap: 14, quote: 'raise the limit to 14', originClaudeSessionId: SID });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, from: sessionSlots.DEFAULT_SLOTS, to: 14 });
    expect(sessionSlots.totalSlots()).toBe(14);
    expect(audit).toHaveBeenCalledTimes(1);
  });

  test('403 quote_does_not_name_slots when the quote names a different number', async () => {
    humanPromptLedger.recordHumanPrompt(SID, QUOTE, clock - 1_000);
    const res = await call('POST', { cap: 20, quote: QUOTE, originClaudeSessionId: SID });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('quote_does_not_name_slots');
    expectNoWrite();
  });

  test.each([[33], [-1], [2.5], ['10'], [null]])('400 for cap %j', async (cap) => {
    humanPromptLedger.recordHumanPrompt(SID, QUOTE, clock - 1_000);
    const res = await call('POST', { cap, quote: QUOTE, originClaudeSessionId: SID });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_request');
    expectNoWrite();
  });

  test('400 for a missing session id, unknown key or bad JSON', async () => {
    for (const body of [{ cap: 10, quote: QUOTE }, { cap: 10, quote: QUOTE, originClaudeSessionId: SID, x: 1 }, '{nope']) {
      const res = await call('POST', body);
      expect(res.status).toBe(400);
    }
    expectNoWrite();
  });

  test('403 called_from_headless_job when a scheduled job calls, even with a matching quote', async () => {
    humanPromptLedger.recordHumanPrompt(SID, QUOTE, clock - 1_000);
    const res = await call('POST', { cap: 10, quote: QUOTE, originClaudeSessionId: SID, callerJobSlug: '4028-x' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('called_from_headless_job');
    expectNoWrite();
  });
});

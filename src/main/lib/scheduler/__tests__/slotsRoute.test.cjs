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
const { registerSlotsRoute, quoteNamesSlots } = require('../slotsRoute.cjs');

const SID = 'chat-session-slots';
const QUOTE = 'lets see first 10 sessions chugging and then we will move the limit via the mcp';

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
  test.each([
    [QUOTE, 10, true],
    ['raise the parallel limit to twelve', 12, true],
    ['set concurrent jobs to 8', 8, true],
    ['make it thirty two slots', 32, true],
    ['set it to 10 please', 10, false],
    ['raise the session limit to 10', 12, false],
    ['raise the session limit to 100', 10, false],
  ])('%s / %i → %s', (q, n, want) => {
    expect(quoteNamesSlots(q, n)).toBe(want);
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
    humanPromptLedger.recordHumanPrompt(SID, `ok: ${QUOTE}. thanks`, at);
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
    expectNoWrite();
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

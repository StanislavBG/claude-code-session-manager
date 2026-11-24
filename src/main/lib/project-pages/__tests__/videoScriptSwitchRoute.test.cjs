/**
 * videoScriptSwitchRoute.test.cjs — POST /admin/project-home/videos/script-switch
 * (lib/project-pages/videoScriptSwitchRoute.cjs) over the REAL switch store
 * (tmp SM_SCHEDULER_HOME) and the REAL humanPromptLedger; project resolution,
 * audit and clock injected.
 *
 * Run: timeout 300 npx vitest run src/main/lib/project-pages/__tests__/videoScriptSwitchRoute.test.cjs
 */
'use strict';

import { test, expect, describe, beforeEach, afterEach, vi } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const videoScriptPress = require('../videoScriptPress.cjs');
const humanPromptLedger = require('../../feedback-remote/humanPromptLedger.cjs');
const { registerVideoScriptSwitchRoute, quoteNamesVideoScriptSwitch } = require('../videoScriptSwitchRoute.cjs');
const { registerAppAdminRoutes } = require('../../../adminRouteRegistry.cjs');

const ROUTE = 'POST /admin/project-home/videos/script-switch';
const SID = 'chat-session-1';
const QUOTE = "please turn on 'Scripts may run Demo Video' for this project";

function fakeReq(body) {
  const req = new EventEmitter();
  req.setTimeout = () => {};
  req.destroy = () => {};
  setImmediate(() => {
    req.emit('data', Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)));
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
let own;
let other;
let audit;
let clock;
let handler;
let ctxFn;

function register(extra = {}) {
  const handlers = new Map();
  registerVideoScriptSwitchRoute({ registerRoute: (m, p, h) => handlers.set(`${m} ${p}`, h) }, {
    resolveProjectContext: (o) => ctxFn(o),
    resolveProjectRoot: (c) => {
      if (!path.isAbsolute(c)) throw new Error('cwd must be absolute');
      return c.startsWith(own) ? own : c.startsWith(other) ? other : c;
    },
    appendAuditEvent: audit,
    now: () => clock,
    ...extra,
  });
  handler = handlers.get(ROUTE);
}

async function call(body) {
  const res = fakeRes();
  await handler(fakeReq(body), res);
  return res;
}

function seed(text, at) {
  humanPromptLedger.recordHumanPrompt(SID, text, at);
}

beforeEach(() => {
  schedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-videoswitchroute-sched-'));
  prevSchedHome = process.env.SM_SCHEDULER_HOME;
  process.env.SM_SCHEDULER_HOME = schedHome;
  own = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-own-proj-'));
  other = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sm-other-')), 'burrow-app');
  fs.mkdirSync(other);
  videoScriptPress._resetForTests();
  humanPromptLedger._resetForTests();
  audit = vi.fn();
  clock = Date.now() + 60_000;
  ctxFn = () => ({ cwd: own, epicId: 'e1', epicCwd: own, source: 'epic-index' });
  register();
});

afterEach(() => {
  vi.restoreAllMocks();
  if (prevSchedHome === undefined) delete process.env.SM_SCHEDULER_HOME;
  else process.env.SM_SCHEDULER_HOME = prevSchedHome;
  videoScriptPress._resetForTests();
  humanPromptLedger._resetForTests();
});

function expectNoWrite() {
  expect(videoScriptPress.getVideoScriptSwitch(own).changedAt).toBe(null);
  expect(videoScriptPress.getVideoScriptSwitch(other).changedAt).toBe(null);
  expect(audit).not.toHaveBeenCalled();
}

describe('quoteNamesVideoScriptSwitch', () => {
  test.each([
    'Scripts may run Demo Video',
    'turn on scripts may run demo video',
    "'Script may Run Demo Videos' that is",
    'scripts can run demo video',
    '“Scripts-may-run-Demo-Video”',
    'SCRIPTS_MAY_RUN_DEMO_VIDEO please',
    'enable "scripts   may run   demo video"',
    'enable ‘Scripts may run Demo Video’ now',
  ])('true for %s', (q) => { expect(quoteNamesVideoScriptSwitch(q)).toBe(true); });

  test.each([
    'Scripts may run Tasks',
    'scripts can run tasks',
    'run the demo video',
    'scripts may run video',
    'scripts may run demo',
    'myscripts may run demo video',
    'scripts may run demo videofoo',
    '',
  ])('false for %s', (q) => { expect(quoteNamesVideoScriptSwitch(q)).toBe(false); });

  test('false for a non-string', () => { expect(quoteNamesVideoScriptSwitch(null)).toBe(false); });
});

describe('POST /admin/project-home/videos/script-switch', () => {
  test('is registered by adminRouteRegistry.registerAppAdminRoutes', () => {
    const routes = [];
    registerAppAdminRoutes({ registerRoute: (m, p) => routes.push(`${m} ${p}`) });
    expect(routes).toContain(ROUTE);
  });

  test.each([
    [{}],
    [{ enabled: 'yes', humanRequestQuote: QUOTE, originClaudeSessionId: SID }],
    [{ enabled: true, humanRequestQuote: '', originClaudeSessionId: SID }],
    [{ enabled: true, humanRequestQuote: 'x'.repeat(2001), originClaudeSessionId: SID }],
    [{ enabled: true, humanRequestQuote: QUOTE, originClaudeSessionId: '' }],
    [{ enabled: true, humanRequestQuote: QUOTE, originClaudeSessionId: 's'.repeat(129) }],
    [{ enabled: true, humanRequestQuote: QUOTE, originClaudeSessionId: SID, extra: 1 }],
    ['not json'],
  ])('400 invalid_request for a bad body %#', async (body) => {
    seed(QUOTE, clock - 1000);
    const res = await call(body);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_request');
    expectNoWrite();
  });

  test('400 for a body over 64 KiB', async () => {
    seed(QUOTE, clock - 1000);
    const big = JSON.stringify({ enabled: true, humanRequestQuote: QUOTE, originClaudeSessionId: SID, pad: 'x'.repeat(70 * 1024) });
    const res = await call(big);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_request');
    expectNoWrite();
  });

  test('400 when cwd is not a project root', async () => {
    seed(QUOTE, clock - 1000);
    const res = await call({ enabled: true, humanRequestQuote: QUOTE, originClaudeSessionId: SID, cwd: path.join(own, 'sub') });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_request');
    expectNoWrite();
  });

  test('400 when no target project resolves', async () => {
    ctxFn = () => ({ cwd: null, epicId: null, epicCwd: null, source: 'cwd' });
    seed(QUOTE, clock - 1000);
    const res = await call({ enabled: true, humanRequestQuote: QUOTE, originClaudeSessionId: SID });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_request');
    expectNoWrite();
  });

  test('403 human_request_unverified when the quote is not in a human prompt of this session', async () => {
    seed('something else entirely, nothing about switches', clock - 1000);
    humanPromptLedger.recordHumanPrompt('another-session', QUOTE, clock - 1000);
    const res = await call({ enabled: true, humanRequestQuote: QUOTE, originClaudeSessionId: SID });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ ok: false, error: 'human_request_unverified' });
    expect(typeof res.body.reason).toBe('string');
    expectNoWrite();
  });

  test('human_request_unverified is checked before the switch name', async () => {
    const q = 'please run the demo video';
    const res = await call({ enabled: true, humanRequestQuote: q, originClaudeSessionId: SID });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('human_request_unverified');
    expectNoWrite();
  });

  test('403 quote_does_not_name_switch', async () => {
    const q = 'please go ahead and run the demo video for this project';
    seed(q, clock - 1000);
    const res = await call({ enabled: true, humanRequestQuote: q, originClaudeSessionId: SID });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ ok: false, error: 'quote_does_not_name_switch' });
    expect(typeof res.body.reason).toBe('string');
    expectNoWrite();
  });

  test("403 quote_does_not_name_switch for the Tasks switch's name", async () => {
    const q = "turn on 'Scripts may run Tasks'";
    seed(q, clock - 1000);
    const res = await call({ enabled: true, humanRequestQuote: q, originClaudeSessionId: SID });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('quote_does_not_name_switch');
    expectNoWrite();
  });

  test('403 quote_does_not_name_project for another project the quote does not name', async () => {
    seed(QUOTE, clock - 1000);
    const res = await call({ enabled: true, humanRequestQuote: QUOTE, originClaudeSessionId: SID, cwd: other });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ ok: false, error: 'quote_does_not_name_project' });
    expect(typeof res.body.reason).toBe('string');
    expectNoWrite();
  });

  test('another project is allowed when the quote names it', async () => {
    const q = "turn on 'Scripts may run Demo Video' for burrow-app";
    seed(q, clock - 1000);
    const res = await call({ enabled: true, humanRequestQuote: q, originClaudeSessionId: SID, cwd: other });
    expect(res.status).toBe(200);
    expect(res.body.cwd).toBe(path.resolve(other));
    expect(videoScriptPress.isVideoScriptSwitchOn(other)).toBe(true);
    expect(videoScriptPress.isVideoScriptSwitchOn(own)).toBe(false);
  });

  test('200: writes with agent attribution and audits once', async () => {
    const at = clock - 1000;
    seed(`hey, ${QUOTE}, thanks`, at);
    const setSpy = vi.spyOn(videoScriptPress, 'setVideoScriptSwitch');
    const res = await call({ enabled: true, humanRequestQuote: QUOTE, originClaudeSessionId: SID });
    expect(res.status).toBe(200);
    const by = { via: 'agent', claudeSessionId: SID, quote: QUOTE, promptAt: new Date(at).toISOString() };
    expect(setSpy).toHaveBeenCalledTimes(1);
    expect(setSpy).toHaveBeenCalledWith(path.resolve(own), true, by);
    const entry = videoScriptPress.getVideoScriptSwitch(own);
    expect(entry.enabled).toBe(true);
    expect(entry.by).toEqual(by);
    expect(res.body).toEqual({
      ok: true,
      cwd: path.resolve(own),
      enabled: true,
      changedAt: entry.changedAt,
      by,
      previous: { enabled: false, by: null },
    });
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledWith('video_script_switch_changed', { cwd: path.resolve(own), enabled: true, via: 'agent', claudeSessionId: SID, quote: QUOTE });
  });

  test('a second call with the same quote is refused 409 and writes nothing', async () => {
    seed(QUOTE, Date.now() - 1000);
    clock = Date.now();
    expect((await call({ enabled: true, humanRequestQuote: QUOTE, originClaudeSessionId: SID })).status).toBe(200);
    const before = videoScriptPress.getVideoScriptSwitch(own);
    audit.mockClear();
    const res = await call({ enabled: false, humanRequestQuote: QUOTE, originClaudeSessionId: SID });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ ok: false, error: 'request_older_than_switch' });
    expect(typeof res.body.reason).toBe('string');
    expect(videoScriptPress.getVideoScriptSwitch(own)).toEqual(before);
    expect(audit).not.toHaveBeenCalled();
  });

  test('409 when a UI click came after the human prompt', async () => {
    seed(QUOTE, Date.now() - 5000);
    videoScriptPress.setVideoScriptSwitch(own, true, { via: 'ui' });
    const before = videoScriptPress.getVideoScriptSwitch(own);
    const res = await call({ enabled: false, humanRequestQuote: QUOTE, originClaudeSessionId: SID });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('request_older_than_switch');
    expect(videoScriptPress.getVideoScriptSwitch(own)).toEqual(before);
    expect(audit).not.toHaveBeenCalled();
  });

  test('a newer prompt can turn it off and reports the previous state; same value re-stamps', async () => {
    videoScriptPress.setVideoScriptSwitch(own, true, { via: 'ui' });
    const offQuote = "now switch off 'Scripts may run Demo Video' here";
    seed(offQuote, Date.now() + 1000);
    clock = Date.now() + 2000;
    const res = await call({ enabled: false, humanRequestQuote: offQuote, originClaudeSessionId: SID });
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(false);
    expect(res.body.previous).toEqual({ enabled: true, by: { via: 'ui' } });

    const again = 'confirm scripts can run demo video stays off please';
    seed(again, Date.now() + 5000);
    clock = Date.now() + 6000;
    const res2 = await call({ enabled: false, humanRequestQuote: again, originClaudeSessionId: SID });
    expect(res2.status).toBe(200);
    expect(res2.body.by.quote).toBe(again);
    expect(res2.body.previous).toEqual({ enabled: false, by: res.body.by });
  });

  test('origin falls back to ctx.cwd and passes originProjectRoot through', async () => {
    const seen = [];
    ctxFn = (o) => { seen.push(o); return { cwd: own, epicId: null, epicCwd: null, source: 'cwd' }; };
    seed(QUOTE, clock - 1000);
    const res = await call({ enabled: true, humanRequestQuote: QUOTE, originClaudeSessionId: SID, originProjectRoot: own });
    expect(res.status).toBe(200);
    expect(seen[0]).toEqual({ originClaudeSessionId: SID, originProjectRoot: own });
  });
});

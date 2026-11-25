/**
 * videoScriptRunRoute.test.cjs — POST /admin/project-home/videos/run
 * (lib/project-pages/videoScriptRunRoute.cjs) over the REAL videoScriptPress
 * store (tmp SM_SCHEDULER_HOME) and real videoPressLines; cwd resolution,
 * voices, job rows, launch and audit injected.
 *
 * Run: timeout 300 npx vitest run src/main/lib/project-pages/__tests__/videoScriptRunRoute.test.cjs
 */
'use strict';

import { test, expect, describe, beforeEach, afterEach, vi } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const videoScriptPress = require('../videoScriptPress.cjs');
const { pressLines, parseScriptPress } = require('../videoPressLines.cjs');
const { BUILTIN_MACROS } = require('../../persona-macro/builtinMacros.cjs');
const { registerAdminRoute } = require('../videoScriptRunRoute.cjs');
const { registerAppAdminRoutes } = require('../../../adminRouteRegistry.cjs');

const ROUTE = 'POST /admin/project-home/videos/run';
const DEMO = BUILTIN_MACROS.find((m) => m.id === 'builtin-demo-video');

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
let cwd;
let audit;
let launches;
let launchImpl;
let rows;
let handler;
let n;

function register(extra = {}) {
  const handlers = new Map();
  registerAdminRoute({ registerRoute: (m, p, h) => handlers.set(`${m} ${p}`, h) }, {
    resolveCwd: (c) => (c === cwd ? { ok: true, cwd } : { ok: false, status: 400, error: 'cwd rejected: outside allowed roots' }),
    listVoices: () => ({ voices: [{ id: 'af_heart' }, { id: 'my-voice' }], errors: [] }),
    listJobRows: async () => rows,
    isTabBusy: () => false,
    appendAuditEvent: (k, f) => audit.push([k, f]),
    startExternalNewSession: async (p) => { launches.push(p); return launchImpl(p); },
    ...extra,
  });
  handler = handlers.get(ROUTE);
}

async function call(body) {
  const res = fakeRes();
  await handler(fakeReq(body), res);
  return res;
}

function switchOn() {
  videoScriptPress.setVideoScriptSwitch(cwd, true, { via: 'ui' });
}

beforeEach(() => {
  prevSchedHome = process.env.SM_SCHEDULER_HOME;
  schedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'vsrun-'));
  process.env.SM_SCHEDULER_HOME = schedHome;
  videoScriptPress._resetForTests();
  cwd = path.join(schedHome, 'proj');
  audit = [];
  launches = [];
  rows = [];
  n = 0;
  launchImpl = async () => { n += 1; return { ok: true, epicId: `epic-${n}`, entryId: `vid-${n}`, slug: `demo-video-build-${n}`, stage: null }; };
  register();
});

afterEach(() => {
  if (prevSchedHome === undefined) delete process.env.SM_SCHEDULER_HOME;
  else process.env.SM_SCHEDULER_HOME = prevSchedHome;
  videoScriptPress._resetForTests();
  fs.rmSync(schedHome, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe(ROUTE, () => {
  test('is registered by adminRouteRegistry.registerAppAdminRoutes', () => {
    const routes = [];
    registerAppAdminRoutes({ registerRoute: (m, p) => routes.push(`${m} ${p}`) });
    expect(routes).toContain(ROUTE);
  });

  test('switch off: 403 scripts_not_allowed naming the switch, nothing launched', async () => {
    const res = await call({ cwd, kind: 'Project demo' });
    expect(res.status).toBe(403);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toBe('scripts_not_allowed');
    expect(res.body.reason).toContain('Scripts may run Demo Video');
    expect(res.body.reason).toContain('Project Home > Video');
    expect(res.body.reason).not.toMatch(/\n/);
    expect(launches).toEqual([]);
    expect(audit).toEqual([]);
  });

  test('switch turned off again refuses', async () => {
    switchOn();
    videoScriptPress.setVideoScriptSwitch(cwd, false, { via: 'ui' });
    const res = await call({ cwd, kind: 'Project demo' });
    expect(res.status).toBe(403);
    expect(launches).toEqual([]);
  });

  test.each([
    [{ kind: 'Nope' }],
    [{ kind: 'Blog post' }],
    [{ kind: 'Project demo', length: 15 }],
    [{ kind: 'Feature', target: 'x', focus: 'Review: approved' }],
    [{ kind: 'Project demo', externalRef: 'has space' }],
    [{ kind: 'Project demo', bogus: 1 }],
  ])('bad input %j: 400 one-line error, nothing launched', async (extra) => {
    switchOn();
    const res = await call({ cwd, ...extra });
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(typeof res.body.error).toBe('string');
    expect(res.body.error).not.toMatch(/\n/);
    expect(launches).toEqual([]);
  });

  test('bad cwd and invalid JSON: 400', async () => {
    switchOn();
    expect((await call({ cwd: '/elsewhere', kind: 'Project demo' })).status).toBe(400);
    expect((await call('not json')).status).toBe(400);
    expect(launches).toEqual([]);
  });

  test('unknown voice: 400, nothing launched', async () => {
    switchOn();
    const res = await call({ cwd, kind: 'Project demo', voiceId: 'ghost-voice' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('ghost-voice');
    expect(launches).toEqual([]);
  });

  test.each(['pending', 'held', 'running'])('a %s builtin-demo-video row for the cwd: 409 already_building', async (status) => {
    switchOn();
    rows = [
      { slug: 'other-cwd', macroId: 'builtin-demo-video', cwd: '/other', status: 'running' },
      { slug: 'done-one', macroId: 'builtin-demo-video', cwd, status: 'completed' },
      { slug: 'busy-one', macroId: 'builtin-demo-video', cwd, status },
    ];
    const res = await call({ cwd, kind: 'Project demo' });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ ok: false, error: 'already_building', activeSlug: 'busy-one' });
    expect(launches).toEqual([]);
  });

  test('ok: launches the press payload, records the run, one audit event', async () => {
    switchOn();
    rows = [{ slug: 'other', macroId: 'builtin-demo-video', cwd: '/other', status: 'running' }];
    const body = { kind: 'blog-post', target: 'posts/hello.md', length: 60, style: 'Fun', character: false, voiceId: 'my-voice', focus: 'Keep it short', reviewFirst: true };
    const res = await call({ cwd, ...body });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, entryId: 'vid-1', epicId: 'epic-1', slug: 'demo-video-build-1', stage: null });
    const cfg = parseScriptPress(body).cfg;
    expect(launches).toEqual([{
      cwd,
      agentName: 'demo-video-builder',
      tag: DEMO.tag,
      title: DEMO.label,
      prompt: `${DEMO.prompt}\n\nAdditional instructions: ${pressLines(cfg).join('\n')}`,
      macroId: 'builtin-demo-video',
      via: 'script',
      reviewStage: true,
    }]);
    expect(launches[0].prompt).toContain('Video kind: Blog post');
    expect(launches[0].prompt).toContain('Voice: my-voice');
    const run = videoScriptPress.findScriptRun(cwd, { entryId: 'vid-1' });
    expect(run).toMatchObject({ entryId: 'vid-1', epicId: 'epic-1', slug: 'demo-video-build-1', kind: 'Blog post' });
    expect(audit).toHaveLength(1);
    expect(audit[0][0]).toBe('admin_video_script_run');
    expect(audit[0][1]).toMatchObject({ cwd, entryId: 'vid-1', epicId: 'epic-1' });
  });

  test('without reviewFirst the payload carries no reviewStage or externalRef', async () => {
    switchOn();
    const res = await call({ cwd, kind: 'Project demo' });
    expect(res.status).toBe(200);
    expect(launches[0]).not.toHaveProperty('reviewStage');
    expect(launches[0]).not.toHaveProperty('externalRef');
  });

  test('externalRef: a repeat answers existing from the ledger without launching', async () => {
    switchOn();
    const first = await call({ cwd, kind: 'Project demo', externalRef: 'post:hello' });
    expect(first.status).toBe(200);
    expect(launches).toHaveLength(1);
    expect(launches[0].externalRef).toBe('post:hello');
    expect(videoScriptPress.findScriptRun(cwd, { externalRef: 'post:hello' })).toMatchObject({ entryId: 'vid-1' });
    // Even while that build is still running.
    rows = [{ slug: 'demo-video-build-1', macroId: 'builtin-demo-video', cwd, status: 'running' }];
    const again = await call({ cwd, kind: 'Project demo', externalRef: 'post:hello' });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ ok: true, existing: true, entryId: 'vid-1', epicId: 'epic-1' });
    expect(launches).toHaveLength(1);
    expect(audit).toHaveLength(1);
  });

  test('externalRef: concurrent identical calls share one launch', async () => {
    switchOn();
    let release;
    launchImpl = () => new Promise((r) => { release = () => r({ ok: true, epicId: 'epic-c', entryId: 'vid-c', slug: 'slug-c', stage: 'review' }); });
    const p1 = call({ cwd, kind: 'Project demo', externalRef: 'ref-1' });
    const p2 = call({ cwd, kind: 'Project demo', externalRef: 'ref-1' });
    await new Promise((r) => setTimeout(r, 30));
    expect(launches).toHaveLength(1);
    release();
    const [a, b] = await Promise.all([p1, p2]);
    expect(launches).toHaveLength(1);
    expect(a.body).toEqual({ ok: true, entryId: 'vid-c', epicId: 'epic-c', slug: 'slug-c', stage: 'review' });
    expect(b.body).toMatchObject({ ok: true, existing: true, entryId: 'vid-c', epicId: 'epic-c' });
  });

  test('a press while another launch is in flight for the cwd: 409', async () => {
    switchOn();
    let release;
    launchImpl = () => new Promise((r) => { release = () => r({ ok: true, epicId: 'e', entryId: 'v', slug: 's', stage: null }); });
    const p1 = call({ cwd, kind: 'Project demo' });
    await new Promise((r) => setTimeout(r, 30));
    const second = await call({ cwd, kind: 'Project demo' });
    expect(second.status).toBe(409);
    expect(second.body.error).toBe('already_building');
    release();
    expect((await p1).status).toBe(200);
    expect(launches).toHaveLength(1);
  });

  test.each([
    ['failed result', async () => ({ ok: false, reason: 'no-window', error: 'Session Manager window is not open' })],
    ['thrown error', async () => { throw new Error('boom'); }],
    ['result without entryId', async () => ({ ok: true, epicId: 'epic-x' })],
  ])('launch failure (%s): 503 one-line error, nothing recorded or audited', async (_name, impl) => {
    switchOn();
    launchImpl = impl;
    const res = await call({ cwd, kind: 'Project demo', externalRef: 'ref-f' });
    expect(res.status).toBe(503);
    expect(res.body.ok).toBe(false);
    expect(typeof res.body.error).toBe('string');
    expect(res.body.error).not.toMatch(/\n/);
    expect(audit).toEqual([]);
    expect(videoScriptPress.findScriptRun(cwd, { externalRef: 'ref-f' })).toBeNull();
  });
});

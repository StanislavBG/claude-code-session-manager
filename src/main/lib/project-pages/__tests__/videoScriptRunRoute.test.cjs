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
      startedBy: { kind: 'script', route: '/admin/project-home/videos/run' },
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

  test('startedBy carries the caller; recorded in audit', async () => {
    switchOn();
    const caller = { pipeline: 'blog', runId: 'r1', step: 'video', attempt: 2 };
    const res = await call({ cwd, kind: 'Project demo', caller });
    expect(res.status).toBe(200);
    expect(launches[0].startedBy).toEqual({ kind: 'script', route: '/admin/project-home/videos/run', caller });
    expect(audit[0][1]).toMatchObject({ caller });
  });

  test('resolved chat adds fromEpicId/fromCwd', async () => {
    switchOn();
    register({
      startedByFromRequest: async ({ route, caller }) => ({ kind: 'script', route, caller, fromCwd: '/p', fromEpicId: 'ep-9' }),
    });
    const res = await call({ cwd, kind: 'Project demo', caller: { pipeline: 'x' } });
    expect(res.status).toBe(200);
    expect(launches[0].startedBy).toMatchObject({ fromCwd: '/p', fromEpicId: 'ep-9', caller: { pipeline: 'x' } });
    expect(audit[0][1]).toMatchObject({ fromEpicId: 'ep-9', caller: { pipeline: 'x' } });
  });

  test('ledger run carries caller and fromEpicId', async () => {
    switchOn();
    const caller = { pipeline: 'blog_publish', runId: 'r1' };
    register({
      startedByFromRequest: async ({ route, caller: c }) => ({ kind: 'script', route, caller: c, fromCwd: '/p', fromEpicId: 'ep-9' }),
    });
    const res = await call({ cwd, kind: 'Project demo', caller });
    expect(res.status).toBe(200);
    const run = videoScriptPress.findScriptRun(cwd, { entryId: 'vid-1' });
    expect(run).toMatchObject({ caller, fromEpicId: 'ep-9' });
  });

  test.each([[{ bogus: 1 }], [{ attempt: -1 }], ['str']])('invalid caller %j: 400, nothing launched', async (caller) => {
    switchOn();
    const res = await call({ cwd, kind: 'Project demo', caller });
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(launches).toEqual([]);
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

describe('GET /admin/project-home/videos/status', () => {
  const STATUS = 'GET /admin/project-home/videos/status';
  let statusHandler;

  function registerStatus() {
    const handlers = new Map();
    registerAdminRoute({ registerRoute: (m, p, h) => handlers.set(`${m} ${p}`, h) }, {
      resolveCwd: (c) => (c === cwd ? { ok: true, cwd } : { ok: false, status: 400, error: 'cwd rejected' }),
      listJobRows: async () => rows,
      readHistoryTail: async () => '',
    });
    statusHandler = handlers.get(STATUS);
  }

  async function status(id, c = cwd) {
    const res = fakeRes();
    const q = new URLSearchParams();
    if (c !== undefined) q.set('cwd', c);
    if (id !== undefined) q.set('id', id);
    await statusHandler(fakeReq(''), res, q);
    return res;
  }

  const entryDir = (id) => path.join(cwd, 'session-manager-operations', 'project-pages', 'videos', id);
  function put(id, rel, content = '{}') {
    const f = path.join(entryDir(id), rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, content);
    return f;
  }
  function ledger(id, slug) {
    videoScriptPress.recordScriptRun(cwd, { entryId: id, epicId: `epic-${id}`, slug, kind: 'Project demo', at: new Date().toISOString() });
  }

  beforeEach(() => {
    fs.mkdirSync(path.join(cwd, 'session-manager-operations'), { recursive: true });
    registerStatus();
  });

  test('is registered by adminRouteRegistry.registerAppAdminRoutes', () => {
    const routes = [];
    registerAppAdminRoutes({ registerRoute: (m, p) => routes.push(`${m} ${p}`) });
    expect(routes).toContain(STATUS);
  });

  test.each([['../etc'], ['UPPER'], [''], ['-lead'], ['a'.repeat(65)], ['a/b']])('bad id %j: 400, no fs read', async (id) => {
    const spy = vi.spyOn(fs, 'statSync');
    const res = await status(id);
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  test('bad cwd: 400', async () => {
    const res = await status('vid-1', '/nope');
    expect(res.status).toBe(400);
  });

  test('unknown id: 404 not found', async () => {
    const res = await status('vid-nope');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ ok: false, error: 'not found' });
  });

  test('season-complete: reason is the outcome text', async () => {
    ledger('vid-s', 'slug-s');
    put('vid-s', 'outcome.json', JSON.stringify({ id: 'vid-s', outcome: 'season-complete', text: 'All episodes are done.', at: new Date().toISOString() }));
    put('vid-s', 'index.html', '<html>');
    put('vid-s', 'meta.json');
    const res = await status('vid-s');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, entryId: 'vid-s', epicId: 'epic-vid-s', slug: 'slug-s', state: 'season-complete', reason: 'All episodes are done.' });
  });

  test('saved: files lists only existing files, absolute paths', async () => {
    ledger('vid-a', 'slug-a');
    const index = put('vid-a', 'index.html', '<html>');
    const meta = put('vid-a', 'meta.json');
    const mp4 = put('vid-a', 'video.mp4', 'x');
    put('vid-a', 'review/material.json');
    const res = await status('vid-a');
    expect(res.body.state).toBe('saved');
    expect(res.body.reason).toBeNull();
    expect(res.body.files).toEqual({ index, meta, mp4 });
    expect(path.isAbsolute(res.body.files.index)).toBe(true);
  });

  test('saved with poster', async () => {
    ledger('vid-p', 'slug-p');
    put('vid-p', 'index.html');
    put('vid-p', 'meta.json');
    const poster = put('vid-p', 'poster.png', 'x');
    const res = await status('vid-p');
    expect(res.body.files.poster).toBe(poster);
    expect(res.body.files.mp4).toBeUndefined();
  });

  test('awaiting_review: review material, no final save', async () => {
    ledger('vid-r', 'slug-r');
    put('vid-r', 'review/material.json');
    put('vid-r', 'index.html');
    const res = await status('vid-r');
    expect(res.body.state).toBe('awaiting_review');
  });

  test('queued: ledger run with a pending row', async () => {
    ledger('vid-q', 'slug-q');
    rows = [{ cwd, slug: 'slug-q', status: 'pending', macroId: 'builtin-demo-video' }];
    const res = await status('vid-q');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ state: 'queued', slug: 'slug-q', reason: null, files: null });
  });

  test('queued: ledger run, no row yet', async () => {
    ledger('vid-q2', 'slug-q2');
    const res = await status('vid-q2');
    expect(res.body.state).toBe('queued');
  });

  test('running: running row', async () => {
    ledger('vid-u', 'slug-u');
    rows = [{ cwd, slug: 'slug-u', status: 'running' }];
    expect((await status('vid-u')).body.state).toBe('running');
  });

  test("failed: the row's one-line reason", async () => {
    ledger('vid-f', 'slug-f');
    rows = [{ cwd, slug: 'slug-f', status: 'failed', error: 'render crashed\nstack line' }];
    const res = await status('vid-f');
    expect(res.body.state).toBe('failed');
    expect(res.body.reason).toBe('render crashed');
  });

  test('failed: a completed row with nothing saved', async () => {
    ledger('vid-d', 'slug-d');
    rows = [{ cwd, slug: 'slug-d', status: 'completed' }];
    const res = await status('vid-d');
    expect(res.body.state).toBe('failed');
    expect(res.body.reason).toMatch(/without saving/);
  });

  test('human press (no ledger run): answers from the folder with slug null', async () => {
    put('vid-h', 'index.html');
    put('vid-h', 'meta.json');
    const res = await status('vid-h');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ slug: null, epicId: null, state: 'saved' });
  });

  test('is read-only: no file written', async () => {
    ledger('vid-w', 'slug-w');
    const spies = ['writeFileSync', 'mkdirSync', 'renameSync'].map((k) => vi.spyOn(fs, k));
    await status('vid-w');
    for (const s of spies) expect(s).not.toHaveBeenCalled();
  });
});

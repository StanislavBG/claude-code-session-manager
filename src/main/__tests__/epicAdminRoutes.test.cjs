/**
 * epicAdminRoutes.test.cjs — the two read-only Epic routes over
 * epicOutsideRead.cjs: GET /admin/epics (list) and GET /admin/epic (one).
 * Uses a fake adminHttp that captures handlers and a fake response object,
 * against a temp project with a real session-manager-operations folder.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/epicAdminRoutes.test.cjs
 */

'use strict';

import { test, expect, beforeEach, afterEach } from 'vitest';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { registerAdminRoute } = require('../lib/epic/epicAdminRoutes.cjs');
const { schemas } = require('../ipcSchemas.cjs');
const { recordExternalRef } = require('../lib/epic/externalRefIndex.cjs');

const tmpDirs = [];
let prevHome;

async function mkTmp(prefix) {
  const d = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

beforeEach(async () => {
  prevHome = process.env.SM_SCHEDULER_HOME;
  process.env.SM_SCHEDULER_HOME = await mkTmp('sm-epic-routes-home-');
});

afterEach(async () => {
  if (prevHome === undefined) delete process.env.SM_SCHEDULER_HOME;
  else process.env.SM_SCHEDULER_HOME = prevHome;
  while (tmpDirs.length) await fsp.rm(tmpDirs.pop(), { recursive: true, force: true });
});

function fakeAdminHttp() {
  const routes = new Map();
  return {
    routes,
    registerRoute(method, p, handler) { routes.set(`${method} ${p}`, handler); },
  };
}

function fakeRes() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    writeHead(code, headers) { this.statusCode = code; Object.assign(this.headers, headers || {}); return this; },
    setHeader(k, v) { this.headers[k] = v; },
    end(chunk) { if (chunk) this.body += String(chunk); },
    get json() { return JSON.parse(this.body); },
  };
}

function session(id, cwd, overrides = {}) {
  return {
    id,
    cwd,
    goalText: `Title ${id}\n\nGoal for ${id}.`,
    claudeSessionId: `sess-${id}`,
    status: 'active',
    tag: 'feature',
    agentType: 'architect',
    createdAt: '2026-11-01T00:00:00.000Z',
    ...overrides,
  };
}

async function project(sessions) {
  const cwd = await mkTmp('sm-epic-routes-cwd-');
  const dir = path.join(cwd, 'session-manager-operations', 'prompt-sessions');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'active-index.json'), JSON.stringify({
    sessions: Object.fromEntries(sessions.map((s) => [s.id, s])),
    events: {},
  }));
  return cwd;
}

function setup(cwd, extra = {}) {
  const http = fakeAdminHttp();
  registerAdminRoute(http, { isTabBusy: () => false, listJobs: () => [], projectRoots: () => [cwd], ...extra });
  return http;
}

async function call(http, p, params) {
  const handler = http.routes.get(`GET ${p}`);
  if (!handler) throw new Error(`no route GET ${p}`);
  const res = fakeRes();
  await handler({}, res, new URLSearchParams(params));
  return res;
}

test('registers exactly the two GET routes', () => {
  const http = fakeAdminHttp();
  registerAdminRoute(http, {});
  expect([...http.routes.keys()].sort()).toEqual(['GET /admin/epic', 'GET /admin/epics']);
});

test('GET /admin/epics lists open Epics with paging fields', async () => {
  const cwd = await project([
    session('e-1', cwd0(), { createdAt: '2026-11-01T00:00:00.000Z' }),
    session('e-2', cwd0(), { createdAt: '2026-11-02T00:00:00.000Z' }),
    session('e-3', cwd0(), { status: 'proposed', createdAt: '2026-11-03T00:00:00.000Z' }),
  ]);
  const http = setup(cwd);
  const res = await call(http, '/admin/epics', { cwd, limit: '2' });
  expect(res.statusCode).toBe(200);
  const body = res.json;
  expect(body.ok).toBe(true);
  expect(body.total).toBe(3);
  expect(body.limit).toBe(2);
  expect(body.offset).toBe(0);
  expect(body.hasMore).toBe(true);
  expect(body.epics.map((e) => e.epicId)).toEqual(['e-3', 'e-2']);

  const page2 = (await call(http, '/admin/epics', { cwd, limit: '2', offset: '2' })).json;
  expect(page2.epics.map((e) => e.epicId)).toEqual(['e-1']);
  expect(page2.hasMore).toBe(false);

  const awaiting = (await call(http, '/admin/epics', { cwd, state: 'awaiting_approval' })).json;
  expect(awaiting.epics.map((e) => e.epicId)).toEqual(['e-3']);
  expect(awaiting.limit).toBe(50);
});

test('GET /admin/epic answers by id, by externalRef, and 404 on no match', async () => {
  const cwd = await project([session('e-1', cwd0(), { source: { externalRef: 'ref-1' } })]);
  await recordExternalRef({ cwd, externalRef: 'ref-1', epicId: 'e-1' });
  const http = setup(cwd);

  const byId = await call(http, '/admin/epic', { cwd, id: 'e-1' });
  expect(byId.statusCode).toBe(200);
  expect(byId.json.ok).toBe(true);
  expect(byId.json.epic.epicId).toBe('e-1');
  expect(byId.json.epic.title).toBe('Title e-1');

  const byRef = await call(http, '/admin/epic', { cwd, externalRef: ' ref-1 ' });
  expect(byRef.statusCode).toBe(200);
  expect(byRef.json.epic.epicId).toBe('e-1');

  const missing = await call(http, '/admin/epic', { cwd, id: 'nope' });
  expect(missing.statusCode).toBe(404);
  expect(missing.json).toEqual({ ok: false, error: 'not found' });
});

test('invalid queries answer 400 invalid query with details', async () => {
  const cwd = await project([]);
  const http = setup(cwd);
  const cases = [
    ['/admin/epics', {}],
    ['/admin/epics', { cwd, state: 'sleeping' }],
    ['/admin/epics', { cwd, limit: '0' }],
    ['/admin/epics', { cwd, limit: '201' }],
    ['/admin/epics', { cwd, offset: '-1' }],
    ['/admin/epic', { id: 'e-1' }],
    ['/admin/epic', { cwd }],
    ['/admin/epic', { cwd, id: 'e-1', externalRef: 'ref-1' }],
    ['/admin/epic', { cwd, externalRef: 'bad ref!' }],
  ];
  for (const [p, params] of cases) {
    const res = await call(http, p, params);
    expect(res.statusCode, `${p} ${JSON.stringify(params)}`).toBe(400);
    expect(res.json.ok).toBe(false);
    expect(res.json.error).toBe('invalid query');
    expect(res.json.details).toBeDefined();
  }
});

test('a relative cwd or one without an operations folder answers 400 naming the reason', async () => {
  const bare = await mkTmp('sm-epic-routes-bare-');
  const http = setup(bare);
  for (const p of ['/admin/epics', '/admin/epic']) {
    const rel = await call(http, p, { cwd: 'relative/path', id: 'e-1' });
    expect(rel.statusCode).toBe(400);
    expect(rel.json.ok).toBe(false);
    expect(rel.json.error).toMatch(/absolute/);

    const noOps = await call(http, p, { cwd: bare, id: 'e-1' });
    expect(noOps.statusCode).toBe(400);
    expect(noOps.json.ok).toBe(false);
    expect(noOps.json.error).toMatch(/session-manager-operations/);
  }
});

test('schemas coerce limit/offset with defaults', () => {
  expect(schemas.adminListEpicsQuery.parse({ cwd: '/x' })).toMatchObject({ limit: 50, offset: 0 });
  expect(schemas.adminListEpicsQuery.parse({ cwd: '/x', limit: '7', offset: '3' })).toMatchObject({ limit: 7, offset: 3 });
  expect(() => schemas.adminListEpicsQuery.parse({ cwd: '/x', limit: '1.5' })).toThrow();
  expect(schemas.adminGetEpicQuery.parse({ cwd: '/x', externalRef: ' a ' }).externalRef).toBe('a');
});

// Session rows' own cwd field is informational only; any absolute path works.
function cwd0() { return '/placeholder'; }

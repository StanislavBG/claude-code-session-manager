/**
 * epicAdminRoutes-id-only.test.cjs — GET /admin/epic with an id and no cwd:
 * Session Manager finds the Epic among its registered projects.
 * 200 on one match, 404 on none, 409 on several, 400 for externalRef without cwd.
 *
 * Run: timeout 120 npx vitest run src/main/lib/epic/__tests__/epicAdminRoutes-id-only.test.cjs
 */

'use strict';

import { test, expect, beforeEach, afterEach } from 'vitest';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { registerAdminRoute } = require('../epicAdminRoutes.cjs');

const tmpDirs = [];
let prevHome;

async function mkTmp(prefix) {
  const d = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

beforeEach(async () => {
  prevHome = process.env.SM_SCHEDULER_HOME;
  process.env.SM_SCHEDULER_HOME = await mkTmp('sm-epic-idonly-home-');
});

afterEach(async () => {
  if (prevHome === undefined) delete process.env.SM_SCHEDULER_HOME;
  else process.env.SM_SCHEDULER_HOME = prevHome;
  while (tmpDirs.length) await fsp.rm(tmpDirs.pop(), { recursive: true, force: true });
});

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
    id, cwd,
    goalText: `Title ${id}\n\nGoal for ${id}.`,
    claudeSessionId: `sess-${id}`,
    status: 'active', tag: 'feature', agentType: 'architect',
    createdAt: '2026-11-01T00:00:00.000Z',
    ...overrides,
  };
}

async function project(sessions, archives = []) {
  const cwd = await mkTmp('sm-epic-idonly-cwd-');
  const dir = path.join(cwd, 'session-manager-operations', 'prompt-sessions');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'active-index.json'), JSON.stringify({
    sessions: Object.fromEntries(sessions.map((s) => [s.id, s(cwd)])), events: {},
  }));
  for (const id of archives) {
    fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({
      session: session(id, cwd, { status: 'completed' }), events: [], archivedAt: '2026-11-05T00:00:01.000Z',
    }));
  }
  return cwd;
}

const open = (id) => Object.assign((cwd) => session(id, cwd), { id });

async function get(roots, params) {
  const routes = new Map();
  registerAdminRoute(
    { registerRoute(method, p, handler) { routes.set(`${method} ${p}`, handler); } },
    { isTabBusy: () => false, listJobs: () => [], projectRoots: () => roots },
  );
  const res = fakeRes();
  await routes.get('GET /admin/epic')({}, res, new URLSearchParams(params));
  return res;
}

test('id alone, one registered project holds it → 200 with the record naming its cwd', async () => {
  const a = await project([open('e-1')]);
  const b = await project([open('e-2')], ['e-done']);
  const res = await get([a, b], { id: 'e-1' });
  expect(res.statusCode).toBe(200);
  expect(res.json.ok).toBe(true);
  expect(res.json.epic.epicId).toBe('e-1');
  expect(res.json.epic.cwd).toBe(a);

  const done = await get([a, b], { id: 'e-done', receipt: '1' });
  expect(done.statusCode).toBe(200);
  expect(done.json.epic.cwd).toBe(b);
  expect(done.json.epic.status).toBe('completed');
  expect(done.json.epic).toHaveProperty('receipt');
});

test('id alone, no registered project holds it → 404 not found', async () => {
  const a = await project([open('e-1')]);
  const hidden = await project([open('e-hidden')]);
  for (const id of ['e-missing', 'e-hidden', '../escape']) {
    const res = await get([a], { id });
    expect(res.statusCode).toBe(404);
    expect(res.json).toEqual({ ok: false, error: 'not found' });
  }
  expect(hidden).toBeTruthy();
});

test('id alone, several registered projects hold it → 409 ambiguous with their cwds', async () => {
  const a = await project([open('e-dup')]);
  const b = await project([], ['e-dup']);
  const res = await get([a, b], { id: 'e-dup' });
  expect(res.statusCode).toBe(409);
  expect(res.json).toEqual({ ok: false, error: 'ambiguous epic id', cwds: [a, b].sort() });
});

test('externalRef without cwd → 400; neither id nor externalRef → 400; with cwd, unchanged', async () => {
  const a = await project([open('e-1')]);
  const noCwd = await get([a], { externalRef: 'ref-1' });
  expect(noCwd.statusCode).toBe(400);
  expect(noCwd.json.error).toBe('invalid query');
  const neither = await get([a], {});
  expect(neither.statusCode).toBe(400);
  expect(neither.json.error).toBe('invalid query');
  const both = await get([a], { id: 'e-1', externalRef: 'ref-1', cwd: a });
  expect(both.statusCode).toBe(400);

  const withCwd = await get([a], { cwd: a, id: 'e-1' });
  expect(withCwd.statusCode).toBe(200);
  expect(withCwd.json.epic.cwd).toBe(a);
  const badCwd = await get([a], { cwd: 'relative', id: 'e-1' });
  expect(badCwd.statusCode).toBe(400);
  expect(badCwd.json.error).toBe('cwd must be an absolute path');
});

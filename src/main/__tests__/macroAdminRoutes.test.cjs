/**
 * macroAdminRoutes.test.cjs — lib/macroAdminRoutes.cjs's two routes
 * (GET /admin/macros?cwd=… and POST /admin/macros/save {cwd, id?, label,
 * agentName, tag, prompt}), backed by a temp macros.json via macroLibrary's
 * `{ filePath }` option.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/macroAdminRoutes.test.cjs
 */

'use strict';

import { test, expect, afterEach } from 'vitest';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const config = require('../config.cjs');
const { registerAdminRoute } = require('../lib/macroAdminRoutes.cjs');

const tmpDirs = [];
afterEach(async () => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop();
    await fsp.rm(d, { recursive: true, force: true });
  }
});

async function mkProjectCwd() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-macro-admin-'));
  config.addAllowedRoot(dir);
  fs.mkdirSync(path.join(dir, 'session-manager-operations'), { recursive: true });
  tmpDirs.push(dir);
  return dir;
}

async function mkMacrosFile() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-macro-store-'));
  tmpDirs.push(dir);
  return path.join(dir, 'macros.json');
}

/** Fake adminHttp stub: captures registered routes and invokes one directly. */
function makeFakeAdminHttp() {
  const routes = new Map();
  return {
    registerRoute(method, url, handler) {
      routes.set(`${method} ${url}`, handler);
    },
    async call(method, url, { rawBody, body, query } = {}) {
      const handler = routes.get(`${method} ${url}`);
      if (!handler) throw new Error(`no route registered for ${method} ${url}`);
      const text = rawBody !== undefined ? rawBody : body !== undefined ? JSON.stringify(body) : '';
      const chunks = text ? [Buffer.from(text)] : [];
      const req = {
        on(event, cb) {
          if (event === 'data') chunks.forEach((c) => cb(c));
          if (event === 'end') cb();
          return req;
        },
      };
      let status = null;
      let payload = null;
      const res = {
        writeHead(s) { status = s; },
        end(b) { payload = b ? JSON.parse(b) : null; },
      };
      const params = new URLSearchParams(query || {});
      await handler(req, res, params);
      return { status, body: payload };
    },
    routes,
  };
}

function makeHandlers() {
  let changedCount = 0;
  const onChanged = () => { changedCount += 1; };
  return { onChanged, getChangedCount: () => changedCount };
}

test('registers GET /admin/macros and POST /admin/macros/save', () => {
  const adminHttp = makeFakeAdminHttp();
  const { onChanged } = makeHandlers();
  registerAdminRoute(adminHttp, { onChanged });
  expect([...adminHttp.routes.keys()]).toEqual([
    'GET /admin/macros',
    'POST /admin/macros/save',
  ]);
});

test('create: projects is [cwd], surface is sessions, onChanged called once', async () => {
  const cwd = await mkProjectCwd();
  const filePath = await mkMacrosFile();
  const adminHttp = makeFakeAdminHttp();
  const { onChanged, getChangedCount } = makeHandlers();
  registerAdminRoute(adminHttp, { onChanged }, { filePath });

  const { status, body } = await adminHttp.call('POST', '/admin/macros/save', {
    body: { cwd, label: 'Publish', agentName: 'builder', tag: 'build', prompt: 'Publish this project' },
  });
  expect(status).toBe(200);
  expect(body.ok).toBe(true);
  expect(body.macro.projects).toEqual([fs.realpathSync(cwd)]);
  expect(body.macro.surface).toBe('sessions');
  expect(getChangedCount()).toBe(1);
});

test('list filters by cwd and includes * macros', async () => {
  const cwdA = await mkProjectCwd();
  const cwdB = await mkProjectCwd();
  const filePath = await mkMacrosFile();
  const adminHttp = makeFakeAdminHttp();
  const { onChanged } = makeHandlers();
  registerAdminRoute(adminHttp, { onChanged }, { filePath });

  await adminHttp.call('POST', '/admin/macros/save', {
    body: { cwd: cwdA, label: 'A only', agentName: 'builder', tag: 'build', prompt: 'do a' },
  });
  const macroLibrary = require('../lib/macroLibrary.cjs');
  await macroLibrary.saveMacro({ label: 'Everywhere', agentName: 'builder', tag: 'build', prompt: 'do everywhere', projects: ['*'] }, { filePath });

  const resA = await adminHttp.call('GET', '/admin/macros', { query: { cwd: cwdA } });
  expect(resA.status).toBe(200);
  const labelsA = resA.body.macros.map((m) => m.label);
  expect(labelsA).toContain('A only');
  expect(labelsA).toContain('Everywhere');

  const resB = await adminHttp.call('GET', '/admin/macros', { query: { cwd: cwdB } });
  const labelsB = resB.body.macros.map((m) => m.label);
  expect(labelsB).not.toContain('A only');
  expect(labelsB).toContain('Everywhere');
});

test('builtin id is refused with 400, onChanged never called', async () => {
  const cwd = await mkProjectCwd();
  const filePath = await mkMacrosFile();
  const adminHttp = makeFakeAdminHttp();
  const { onChanged, getChangedCount } = makeHandlers();
  registerAdminRoute(adminHttp, { onChanged }, { filePath });

  const { status, body } = await adminHttp.call('POST', '/admin/macros/save', {
    body: { cwd, id: 'builtin-project-home', label: 'x', agentName: 'builder', tag: 'build', prompt: 'x' },
  });
  expect(status).toBe(400);
  expect(body.ok).toBe(false);
  expect(getChangedCount()).toBe(0);
});

test('unknown id is refused with 400', async () => {
  const cwd = await mkProjectCwd();
  const filePath = await mkMacrosFile();
  const adminHttp = makeFakeAdminHttp();
  const { onChanged, getChangedCount } = makeHandlers();
  registerAdminRoute(adminHttp, { onChanged }, { filePath });

  const { status, body } = await adminHttp.call('POST', '/admin/macros/save', {
    body: { cwd, id: 'nonexistent-abc123', label: 'x', agentName: 'builder', tag: 'build', prompt: 'x' },
  });
  expect(status).toBe(400);
  expect(body.ok).toBe(false);
  expect(getChangedCount()).toBe(0);
});

test('update of a macro whose projects do not include the resolved cwd is refused', async () => {
  const cwdA = await mkProjectCwd();
  const cwdB = await mkProjectCwd();
  const filePath = await mkMacrosFile();
  const adminHttp = makeFakeAdminHttp();
  const { onChanged, getChangedCount } = makeHandlers();
  registerAdminRoute(adminHttp, { onChanged }, { filePath });

  const created = await adminHttp.call('POST', '/admin/macros/save', {
    body: { cwd: cwdA, label: 'A only', agentName: 'builder', tag: 'build', prompt: 'do a' },
  });
  expect(created.status).toBe(200);
  const id = created.body.macro.id;

  const { status, body } = await adminHttp.call('POST', '/admin/macros/save', {
    body: { cwd: cwdB, id, label: 'hijacked', agentName: 'builder', tag: 'build', prompt: 'do b' },
  });
  expect(status).toBe(400);
  expect(body.ok).toBe(false);
  expect(getChangedCount()).toBe(1); // only the create above
});

test('non-absolute cwd is refused with 400 on both routes', async () => {
  const filePath = await mkMacrosFile();
  const adminHttp = makeFakeAdminHttp();
  const { onChanged, getChangedCount } = makeHandlers();
  registerAdminRoute(adminHttp, { onChanged }, { filePath });

  const list = await adminHttp.call('GET', '/admin/macros', { query: { cwd: 'relative/dir' } });
  expect(list.status).toBe(400);

  const save = await adminHttp.call('POST', '/admin/macros/save', {
    body: { cwd: 'relative/dir', label: 'x', agentName: 'builder', tag: 'build', prompt: 'x' },
  });
  expect(save.status).toBe(400);
  expect(getChangedCount()).toBe(0);
});

test('zod validation error on bad field surfaces as a 400 with a message, onChanged never called', async () => {
  const cwd = await mkProjectCwd();
  const filePath = await mkMacrosFile();
  const adminHttp = makeFakeAdminHttp();
  const { onChanged, getChangedCount } = makeHandlers();
  registerAdminRoute(adminHttp, { onChanged }, { filePath });

  const { status, body } = await adminHttp.call('POST', '/admin/macros/save', {
    body: { cwd, label: '', agentName: 'builder', tag: 'build', prompt: 'x' },
  });
  expect(status).toBe(400);
  expect(body.ok).toBe(false);
  expect(typeof body.error).toBe('string');
  expect(getChangedCount()).toBe(0);
});

test('non-project cwd (missing session-manager-operations/) is refused with 400', async () => {
  const filePath = await mkMacrosFile();
  const adminHttp = makeFakeAdminHttp();
  const { onChanged } = makeHandlers();
  registerAdminRoute(adminHttp, { onChanged }, { filePath });

  const bare = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-macro-bare-'));
  tmpDirs.push(bare);
  config.addAllowedRoot(bare);

  const res = await adminHttp.call('GET', '/admin/macros', { query: { cwd: bare } });
  expect(res.status).toBe(400);
  expect(res.body.error).toContain('not a Session Manager project');
});

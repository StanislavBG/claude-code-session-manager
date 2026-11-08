/**
 * projectHomeAdminRoutes.test.cjs — the Competitor matrix admin routes
 * (POST /admin/project-home/matrix/read and /matrix/write). The page/video
 * routes are covered in src/main/__tests__/projectHomeAdminRoutes.test.cjs.
 *
 * Run: timeout 120 npx vitest run src/main/lib/feedback-remote/__tests__/projectHomeAdminRoutes.test.cjs
 */

'use strict';

import { test, expect, afterEach } from 'vitest';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const config = require('../../../config.cjs');
const { registerAdminRoute } = require('../projectHomeAdminRoutes.cjs');
const { matrixJsonSchema, MAX_MATRIX_BYTES } = require('../../project-pages/competitiveMatrix.cjs');

const tmpDirs = [];
afterEach(async () => {
  while (tmpDirs.length) await fsp.rm(tmpDirs.pop(), { recursive: true, force: true });
});

async function mkProjectCwd() {
  const dir = fs.realpathSync(await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-matrix-admin-')));
  config.addAllowedRoot(dir);
  fs.mkdirSync(path.join(dir, 'session-manager-operations'), { recursive: true });
  tmpDirs.push(dir);
  return dir;
}

/** Fake adminHttp stub: captures registered routes and invokes one directly. */
function makeFakeAdminHttp() {
  const routes = new Map();
  return {
    registerRoute(method, url, handler) {
      routes.set(`${method} ${url}`, handler);
    },
    async call(method, url, { rawBody, body } = {}) {
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
        destroy() {},
      };
      let status = null;
      let payload = null;
      const res = {
        writeHead(s) { status = s; },
        end(b) { payload = b ? JSON.parse(b) : null; },
      };
      await handler(req, res, new URLSearchParams());
      return { status, body: payload };
    },
    routes,
  };
}

const T = '2026-11-08T12:00:00.000Z';
function buildMatrix() {
  return {
    schemaVersion: 1,
    product: { id: 'self', name: 'Session Manager', summary: 'cockpit' },
    competitors: [{ id: 'opencode', name: 'OpenCode', category: 'harness', chosenBy: 'user', why: '' }],
    groups: [{ id: 'sessions', title: 'Sessions', description: '' }],
    features: [{
      id: 'f-1', groupId: 'sessions', title: 'Thing', description: 'A thing',
      sentiment: { signal: 'loved', summary: '', sourceIds: [] },
      support: { self: { status: 'no', note: '', sourceIds: [] }, opencode: { status: 'yes', note: '', sourceIds: [] } },
      recommendation: { priority: 'P1', rationale: '', sessionGoal: 'build it' },
      firstSeenAt: T, updatedAt: T,
    }],
    sources: [],
    runs: [{ at: T, model: 'opus', competitors: ['OpenCode'], added: ['f-1'], changed: [], notes: '' }],
    updatedAt: T,
  };
}

function setup() {
  const adminHttp = makeFakeAdminHttp();
  registerAdminRoute(adminHttp);
  return adminHttp;
}

test('registers both matrix routes', () => {
  const keys = [...setup().routes.keys()];
  expect(keys).toContain('POST /admin/project-home/matrix/read');
  expect(keys).toContain('POST /admin/project-home/matrix/write');
});

test('read on a fresh project returns matrix null plus the schema', async () => {
  const cwd = await mkProjectCwd();
  const { status, body } = await setup().call('POST', '/admin/project-home/matrix/read', { body: { cwd } });
  expect(status).toBe(200);
  expect(body.ok).toBe(true);
  expect(body.matrix).toBeNull();
  expect(body.error).toBeNull();
  expect(body.path).toBe(path.join(cwd, 'session-manager-operations', 'project-pages', 'matrix', 'matrix.json'));
  expect(body.schema).toEqual(JSON.parse(JSON.stringify(matrixJsonSchema())));
});

test('write then read round-trips', async () => {
  const cwd = await mkProjectCwd();
  const http = setup();
  const m = buildMatrix();
  const w = await http.call('POST', '/admin/project-home/matrix/write', { body: { cwd, matrix: m, model: 'opus' } });
  expect(w.status).toBe(200);
  expect(w.body.ok).toBe(true);
  expect(fs.existsSync(w.body.path)).toBe(true);
  expect(fs.existsSync(w.body.htmlPath)).toBe(true);
  expect(w.body.historyPath).toBeNull();
  const r = await http.call('POST', '/admin/project-home/matrix/read', { body: { cwd } });
  expect(r.body.ok).toBe(true);
  expect(r.body.matrix).toEqual(m);
  expect(r.body.path).toBe(w.body.path);
});

test('invalid matrix returns ok false and writes nothing', async () => {
  const cwd = await mkProjectCwd();
  const bad = buildMatrix();
  delete bad.product;
  const { status, body } = await setup().call('POST', '/admin/project-home/matrix/write', { body: { cwd, matrix: bad } });
  expect(status).toBe(400);
  expect(body.ok).toBe(false);
  expect(typeof body.error).toBe('string');
  expect(fs.existsSync(path.join(cwd, 'session-manager-operations', 'project-pages'))).toBe(false);
});

test('rejects a missing cwd and an oversized body with 4xx JSON', async () => {
  const http = setup();
  const noCwd = await http.call('POST', '/admin/project-home/matrix/read', { body: {} });
  expect(noCwd.status).toBe(400);
  expect(noCwd.body.ok).toBe(false);
  const cwd = await mkProjectCwd();
  const huge = JSON.stringify({ cwd, matrix: { pad: 'x'.repeat(MAX_MATRIX_BYTES + 65 * 1024) } });
  const big = await http.call('POST', '/admin/project-home/matrix/write', { rawBody: huge });
  expect(big.status).toBeGreaterThanOrEqual(400);
  expect(big.status).toBeLessThan(500);
  expect(big.body.ok).toBe(false);
});

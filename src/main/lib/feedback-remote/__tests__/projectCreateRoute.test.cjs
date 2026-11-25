// @ts-check
/**
 * projectCreateRoute.test.cjs — POST /admin/projects/create through a real
 * createAdminHttp transport: created (notify once with cwd), existing (no
 * notify), a 400 refusal, and invalid JSON (over a real loopback socket,
 * since invoke() always serializes its body).
 *
 * Run: timeout 180 npx vitest run src/main/lib/feedback-remote/__tests__/projectCreateRoute.test.cjs
 */

'use strict';

import { test, expect, beforeEach, afterEach, afterAll } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');
const path = require('node:path');
const { createAdminHttp, TOKEN_PATH } = require('../localAdminHttp.cjs');
const { registerAdminRoute } = require('../projectCreate.cjs');
const { createCreatedProjects } = require('../createdProjects.cjs');

// Never let start() touch the production admin-api.json.
const TEST_TOKEN_PATH = path.join(path.dirname(TOKEN_PATH), `admin-api.project-create-test-${process.pid}.json`);
process.env.SM_ADMIN_TOKEN_PATH = TEST_TOKEN_PATH;
afterAll(() => { fs.rmSync(TEST_TOKEN_PATH, { force: true }); });

const GIT_ENV_KEYS = ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL'];

/** @type {string} */ let tmp;
/** @type {string} */ let parentDir;
/** @type {string} */ let fromCwd;
/** @type {Record<string, string | undefined>} */ let prevEnv;
/** @type {Array<{ cwd: string }>} */ let notified;
/** @type {ReturnType<typeof createAdminHttp>} */ let admin;

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'project-create-route-')));
  parentDir = path.join(tmp, 'projects');
  fromCwd = path.join(tmp, 'service');
  fs.mkdirSync(parentDir);
  fs.mkdirSync(fromCwd);
  prevEnv = {};
  for (const k of GIT_ENV_KEYS) prevEnv[k] = process.env[k];
  process.env.GIT_AUTHOR_NAME = 'Test Author';
  process.env.GIT_AUTHOR_EMAIL = 'test-author@example.invalid';
  process.env.GIT_COMMITTER_NAME = 'Test Author';
  process.env.GIT_COMMITTER_EMAIL = 'test-author@example.invalid';
  notified = [];
  const ledger = createCreatedProjects({ filePath: path.join(tmp, 'ledger', 'created-projects.json') });
  // Fake gh: never reached unless github is requested; fails loudly if it is.
  const execGh = async (/** @type {string[]} */ args) => { throw new Error(`unexpected gh call: ${args.join(' ')}`); };
  admin = createAdminHttp();
  registerAdminRoute(admin, {
    notify: (payload) => { notified.push(payload); },
    deps: { ledger, execGh, validatePath: (abs) => abs, appendAudit: () => {} },
  });
});

afterEach(async () => {
  await admin.stop();
  for (const k of GIT_ENV_KEYS) {
    if (prevEnv[k] === undefined) delete process.env[k];
    else process.env[k] = prevEnv[k];
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

function body(extra = {}) {
  return { name: 'new-proj', parentDir, fromCwd, externalRef: 'kiln:idea-1', ...extra };
}

test('a fresh create answers 200 created and notifies once with the cwd', async () => {
  const out = await admin.invoke('POST', '/admin/projects/create', { body: body() });
  expect(out.status).toBe(200);
  expect(out.json).toMatchObject({ ok: true, status: 'created', name: 'new-proj', repo: null });
  const cwd = path.join(parentDir, 'new-proj');
  expect(out.json.cwd).toBe(cwd);
  expect(fs.statSync(path.join(cwd, '.git')).isDirectory()).toBe(true);
  expect(notified).toEqual([{ cwd }]);
});

test('a repeat answers 200 existing and does not notify again', async () => {
  const first = await admin.invoke('POST', '/admin/projects/create', { body: body() });
  expect(first.json.status).toBe('created');
  const again = await admin.invoke('POST', '/admin/projects/create', { body: body() });
  expect(again.status).toBe(200);
  expect(again.json).toMatchObject({ ok: true, status: 'existing', existing: true, cwd: first.json.cwd });
  expect(notified).toHaveLength(1);
});

test('a refusal answers its own status and creates nothing', async () => {
  const out = await admin.invoke('POST', '/admin/projects/create', { body: body({ name: '../escape' }) });
  expect(out.status).toBe(400);
  expect(out.json).toMatchObject({ ok: false, code: 'invalid-name' });
  expect(fs.readdirSync(parentDir)).toEqual([]);
  expect(notified).toEqual([]);
});

test('invalid JSON answers 400 invalid JSON body', async () => {
  const { port, token } = await admin.start();
  const res = await new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port, method: 'POST', path: '/admin/projects/create',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    }, (r) => {
      /** @type {Buffer[]} */ const chunks = [];
      r.on('data', (c) => chunks.push(c));
      r.on('end', () => resolve({ status: r.statusCode, json: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
    });
    req.on('error', reject);
    req.end('{not json');
  });
  expect(res).toEqual({ status: 400, json: { ok: false, error: 'invalid JSON body' } });
  expect(notified).toEqual([]);
});

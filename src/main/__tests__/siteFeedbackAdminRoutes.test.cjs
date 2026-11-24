/**
 * siteFeedbackAdminRoutes.test.cjs — every /admin/feedback-widget/* and /admin/site-feedback/*
 * route over a stubbed siteFeedbackService: input validation, delegation, own-secret redaction,
 * the stored report returned verbatim, list `id`, and the HTTP status for each failure class.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/siteFeedbackAdminRoutes.test.cjs
 */
'use strict';

import { test, expect } from 'vitest';
const os = require('node:os');
const { registerAdminRoute } = require('../lib/feedback-remote/siteFeedbackAdminRoutes.cjs');

const CWD = '/home/u/proj';
const SNIP = '<script src="x" data-key="fbk1_box1.abc" async></script>';

function makeFakeAdminHttp() {
  const routes = new Map();
  return {
    registerRoute(method, url, handler) { routes.set(`${method} ${url}`, handler); },
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
      const res = { writeHead(s) { status = s; }, end(b) { payload = b ? JSON.parse(b) : null; } };
      await handler(req, res, new URLSearchParams(query || {}));
      return { status, body: payload };
    },
    routes,
  };
}

function makeService(over = {}) {
  const calls = [];
  const rec = (name, result) => async (p) => { calls.push([name, p]); return typeof result === 'function' ? result(p) : result; };
  const service = {
    calls,
    createWidget: rec('createWidget', { ok: true, boxId: 'box1', fingerprint: 'abc', snippet: SNIP, privateKeyJwk: { d: 'SECRET' } }),
    listWidgets: rec('listWidgets', { ok: true, widgets: [{ boxId: 'box1', snippet: SNIP, deviceToken: 'TOKEN' }] }),
    updateWidget: rec('updateWidget', (p) => ({ ok: true, widget: { boxId: p.boxId, label: p.label } })),
    deleteWidget: rec('deleteWidget', (p) => ({ ok: true, boxId: p.boxId })),
    getSnippet: rec('getSnippet', (p) => ({ ok: true, boxId: p.boxId, fingerprint: 'abc', snippet: SNIP })),
    listItems: rec('listItems', { ok: true, items: [{ hostId: 'FB-AB123', status: 'open' }] }),
    getItem: rec('getItem', (p) => ({
      ok: true,
      item: {
        meta: { hostId: p.hostId, status: 'open' },
        report: { v: 1, clientReportId: 'c1', title: 'Broken', screenshot: { part: 'screenshot' }, preview: 'data:image/png;base64,AAAA' },
        imagePaths: { screenshot: '/p/screenshot.png', annotated: '/p/annotated.png' },
        dataUrl: 'data:image/png;base64,AAAA',
      },
    })),
    setStatus: rec('setStatus', (p) => ({ ok: true, meta: { hostId: p.hostId, status: p.status, statusNote: p.note } })),
    ...over,
  };
  return service;
}

function setup(over, boxes = [{ boxId: 'box1', projectCwd: CWD }]) {
  const adminHttp = makeFakeAdminHttp();
  const service = makeService(over);
  const boxKeys = { listBoxes: async () => boxes };
  registerAdminRoute(adminHttp, { service, boxKeys });
  return { adminHttp, service };
}

test('registers all eight routes', () => {
  const { adminHttp } = setup();
  expect([...adminHttp.routes.keys()]).toEqual([
    'POST /admin/feedback-widget/create',
    'GET /admin/feedback-widget/list',
    'POST /admin/feedback-widget/update',
    'POST /admin/feedback-widget/delete',
    'GET /admin/feedback-widget/snippet',
    'GET /admin/site-feedback/inbox',
    'GET /admin/site-feedback/item',
    'POST /admin/site-feedback/status',
  ]);
});

// ── create
test('create delegates normalised input and returns boxId/fingerprint/snippet without the private key', async () => {
  const { adminHttp, service } = setup();
  const r = await adminHttp.call('POST', '/admin/feedback-widget/create', {
    body: { cwd: CWD, label: '  Site  ', allowedOrigins: ['https://a.example/path', 'https://a.example'] },
  });
  expect(r.status).toBe(200);
  expect(r.body).toEqual({ ok: true, boxId: 'box1', fingerprint: 'abc', snippet: SNIP });
  expect(service.calls).toEqual([['createWidget', { cwd: CWD, label: 'Site', allowedOrigins: ['https://a.example'] }]]);
  expect(JSON.stringify(r.body)).not.toContain('SECRET');
});

test.each([
  ['relative cwd', { cwd: 'proj', label: 'x', allowedOrigins: ['https://a.example'] }, /absolute/],
  ['missing label', { cwd: CWD, allowedOrigins: ['https://a.example'] }, /label/],
  ['http origin', { cwd: CWD, label: 'x', allowedOrigins: ['http://a.example'] }, /https/],
  ['no origins', { cwd: CWD, label: 'x', allowedOrigins: [] }, /1-10/],
  ['eleven origins', { cwd: CWD, label: 'x', allowedOrigins: Array.from({ length: 11 }, (_, i) => `https://a${i}.example`) }, /1-10/],
])('create rejects %s', async (_n, body, re) => {
  const { adminHttp, service } = setup();
  const r = await adminHttp.call('POST', '/admin/feedback-widget/create', { body });
  expect(r.status).toBe(400);
  expect(r.body.ok).toBe(false);
  expect(r.body.error).toMatch(re);
  expect(service.calls).toEqual([]);
});

test('create accepts http://localhost and rejects invalid JSON', async () => {
  const { adminHttp } = setup();
  const ok = await adminHttp.call('POST', '/admin/feedback-widget/create', {
    body: { cwd: CWD, label: 'x', allowedOrigins: ['http://localhost:3000'] },
  });
  expect(ok.body.ok).toBe(true);
  const bad = await adminHttp.call('POST', '/admin/feedback-widget/create', { rawBody: '{nope' });
  expect(bad.status).toBe(400);
  expect(bad.body).toEqual({ ok: false, error: 'invalid JSON body' });
});

test('a service failure passes through as ok:false', async () => {
  const { adminHttp } = setup({ createWidget: async () => ({ ok: false, error: 'not_linked', message: 'pair first' }) });
  const r = await adminHttp.call('POST', '/admin/feedback-widget/create', {
    body: { cwd: CWD, label: 'x', allowedOrigins: ['https://a.example'] },
  });
  expect(r.status).toBe(409);
  expect(r.body).toEqual({ ok: false, error: 'not_linked', message: 'pair first' });
});

test.each([
  ['not_linked', 409],
  ['not_enabled', 409],
  ['invalid_input', 400],
  ['invalid_label', 400],
  ['invalid_allowed_origins', 400],
  ['invalid_state', 400],
  ['not_found', 404],
  ['internal', 500],
  ['keystore_failed', 500],
  ['rate_limited', 502],
  ['box_limit_reached', 502],
  ['device_token_required', 502],
  ['box_not_found', 502],
  ['relay_unreachable', 502],
])('a service failure %s answers HTTP %i with ok and error', async (code, status) => {
  const { adminHttp } = setup({ getSnippet: async () => ({ ok: false, error: code, message: 'm', status: 503 }) });
  const r = await adminHttp.call('GET', '/admin/feedback-widget/snippet', { query: { boxId: 'box1' } });
  expect(r.status).toBe(status);
  expect(r.body.ok).toBe(false);
  expect(r.body.error).toBe(code);
});

test('a failure with no error code answers 502 with ok and error', async () => {
  const { adminHttp } = setup({ listItems: async () => ({ ok: false }) });
  const r = await adminHttp.call('GET', '/admin/site-feedback/inbox', { query: { cwd: CWD } });
  expect(r.status).toBe(502);
  expect(r.body.ok).toBe(false);
  expect(typeof r.body.error).toBe('string');
});

test('success answers 200; input errors answer 400 with ok and error', async () => {
  const { adminHttp } = setup();
  expect((await adminHttp.call('GET', '/admin/feedback-widget/snippet', { query: { boxId: 'box1' } })).status).toBe(200);
  const bad = await adminHttp.call('GET', '/admin/site-feedback/item', { query: { cwd: CWD, id: 'nope' } });
  expect(bad.status).toBe(400);
  expect(bad.body.ok).toBe(false);
  expect(typeof bad.body.error).toBe('string');
});

test('a throwing service becomes a 500 ok:false', async () => {
  const { adminHttp } = setup({ listWidgets: async () => { throw new Error('boom'); } });
  const r = await adminHttp.call('GET', '/admin/feedback-widget/list');
  expect(r.status).toBe(500);
  expect(r.body.ok).toBe(false);
});

// ── list
test('list passes cwd and strips the device token', async () => {
  const { adminHttp, service } = setup();
  const r = await adminHttp.call('GET', '/admin/feedback-widget/list', { query: { cwd: CWD } });
  expect(r.body).toEqual({ ok: true, widgets: [{ boxId: 'box1', snippet: SNIP }] });
  expect(service.calls).toEqual([['listWidgets', { cwd: CWD }]]);
});

test('list without cwd lists all; relative cwd is rejected', async () => {
  const { adminHttp, service } = setup();
  await adminHttp.call('GET', '/admin/feedback-widget/list');
  expect(service.calls).toEqual([['listWidgets', {}]]);
  const r = await adminHttp.call('GET', '/admin/feedback-widget/list', { query: { cwd: 'rel' } });
  expect(r.status).toBe(400);
  expect(r.body.ok).toBe(false);
});

// ── update
test('update delegates the patch', async () => {
  const { adminHttp, service } = setup();
  const r = await adminHttp.call('POST', '/admin/feedback-widget/update', {
    body: { boxId: 'box1', label: 'New', allowedOrigins: ['https://b.example'], state: 'paused' },
  });
  expect(r.body).toEqual({ ok: true, widget: { boxId: 'box1', label: 'New' } });
  expect(service.calls).toEqual([['updateWidget', { boxId: 'box1', label: 'New', allowedOrigins: ['https://b.example'], state: 'paused' }]]);
});

test.each([
  ['no boxId', { label: 'x' }, /boxId/],
  ['bad state', { boxId: 'box1', state: 'closed' }, /state/],
  ['bad origin', { boxId: 'box1', allowedOrigins: ['ftp://x'] }, /https/],
  ['empty patch', { boxId: 'box1' }, /Nothing to update/],
])('update rejects %s', async (_n, body, re) => {
  const { adminHttp, service } = setup();
  const r = await adminHttp.call('POST', '/admin/feedback-widget/update', { body });
  expect(r.status).toBe(400);
  expect(r.body.error).toMatch(re);
  expect(service.calls).toEqual([]);
});

// ── delete
test('delete delegates and validates boxId', async () => {
  const { adminHttp, service } = setup();
  const r = await adminHttp.call('POST', '/admin/feedback-widget/delete', { body: { boxId: 'box1' } });
  expect(r.body).toEqual({ ok: true, boxId: 'box1' });
  expect(service.calls).toEqual([['deleteWidget', { boxId: 'box1' }]]);
  const bad = await adminHttp.call('POST', '/admin/feedback-widget/delete', { body: { boxId: '../x' } });
  expect(bad.status).toBe(400);
  expect(bad.body.ok).toBe(false);
});

// ── snippet
test('snippet delegates and validates boxId', async () => {
  const { adminHttp, service } = setup();
  const r = await adminHttp.call('GET', '/admin/feedback-widget/snippet', { query: { boxId: 'box1' } });
  expect(r.body).toEqual({ ok: true, boxId: 'box1', fingerprint: 'abc', snippet: SNIP });
  expect(service.calls).toEqual([['getSnippet', { boxId: 'box1' }]]);
  const bad = await adminHttp.call('GET', '/admin/feedback-widget/snippet');
  expect(bad.status).toBe(400);
});

// ── inbox
test('inbox delegates cwd + status', async () => {
  const { adminHttp, service } = setup();
  const r = await adminHttp.call('GET', '/admin/site-feedback/inbox', { query: { cwd: CWD, status: 'open' } });
  expect(r.body).toEqual({ ok: true, items: [{ id: 'FB-AB123', hostId: 'FB-AB123', status: 'open' }] });
  await adminHttp.call('GET', '/admin/site-feedback/inbox', { query: { cwd: CWD } });
  expect(service.calls).toEqual([['listItems', { cwd: CWD, status: 'open' }], ['listItems', { cwd: CWD }]]);
});

test('inbox rejects relative cwd and unknown status', async () => {
  const { adminHttp, service } = setup();
  expect((await adminHttp.call('GET', '/admin/site-feedback/inbox', { query: { cwd: 'x' } })).status).toBe(400);
  const r = await adminHttp.call('GET', '/admin/site-feedback/inbox', { query: { cwd: CWD, status: 'done' } });
  expect(r.status).toBe(400);
  expect(r.body.error).toMatch(/status must be one of/);
  expect(service.calls).toEqual([]);
});

test('every inbox item carries id = hostId, and that id is what item + status accept', async () => {
  const { adminHttp, service } = setup({
    listItems: async () => ({ ok: true, items: [{ hostId: 'FB-AB123', status: 'open' }, { hostId: 'FB-ZZ999', status: 'resolved' }] }),
  });
  const r = await adminHttp.call('GET', '/admin/site-feedback/inbox', { query: { cwd: CWD } });
  expect(r.body.items.map((i) => [i.id, i.hostId])).toEqual([['FB-AB123', 'FB-AB123'], ['FB-ZZ999', 'FB-ZZ999']]);
  const id = r.body.items[1].id;
  expect((await adminHttp.call('GET', '/admin/site-feedback/item', { query: { cwd: CWD, id } })).status).toBe(200);
  expect((await adminHttp.call('POST', '/admin/site-feedback/status', { body: { cwd: CWD, id, status: 'open' } })).status).toBe(200);
  expect(service.calls.map((c) => c[1].hostId)).toEqual(['FB-ZZ999', 'FB-ZZ999']);
});

// ── item
test('item returns the stored report unmodified, including a field named token or secret', async () => {
  const report = {
    v: 1,
    clientReportId: 'c1',
    title: 'Login broken',
    token: 'visitor-csrf-token-value',
    context: { secret: 'visible', Token: 'T', privateKey: 'visitor text' },
    steps: [{ token: 'step-token' }],
  };
  const { adminHttp } = setup({
    getItem: async (p) => ({
      ok: true,
      item: { meta: { hostId: p.hostId, status: 'open', deviceToken: 'OURS' }, report, imagePaths: { screenshot: '/p/s.png' } },
    }),
  });
  const r = await adminHttp.call('GET', '/admin/site-feedback/item', { query: { cwd: CWD, id: 'FB-AB123' } });
  expect(r.status).toBe(200);
  expect(r.body.item.report).toEqual(report);
  expect(r.body.item.meta).toEqual({ hostId: 'FB-AB123', status: 'open' });
});

test('item returns the full report + local image paths, never image bytes', async () => {
  const { adminHttp, service } = setup();
  const r = await adminHttp.call('GET', '/admin/site-feedback/item', { query: { cwd: CWD, id: 'FB-AB123' } });
  expect(service.calls).toEqual([['getItem', { cwd: CWD, hostId: 'FB-AB123' }]]);
  expect(r.body).toEqual({
    ok: true,
    item: {
      meta: { hostId: 'FB-AB123', status: 'open' },
      report: { v: 1, clientReportId: 'c1', title: 'Broken', screenshot: { part: 'screenshot' }, preview: 'data:image/png;base64,AAAA' },
      imagePaths: { screenshot: '/p/screenshot.png', annotated: '/p/annotated.png' },
      reporterVerified: null,
    },
  });
  expect(r.body.item.dataUrl).toBeUndefined();
});

test.each([[true, true], [false, false], [null, null], [undefined, null], ['yes', null]])(
  'item carries reporterVerified from meta (%j -> %j)',
  async (stored, shown) => {
    const { adminHttp } = setup({
      getItem: async (p) => ({
        ok: true,
        item: { meta: { hostId: p.hostId, status: 'open', reporterVerified: stored }, report: { v: 1 }, imagePaths: {} },
      }),
    });
    const r = await adminHttp.call('GET', '/admin/site-feedback/item', { query: { cwd: CWD, id: 'FB-AB123' } });
    expect(r.status).toBe(200);
    expect(r.body.item.reporterVerified).toBe(shown);
  },
);

test('item passes a not_found failure through without a reporterVerified field', async () => {
  const { adminHttp } = setup({ getItem: async () => ({ ok: false, error: 'not_found' }) });
  const r = await adminHttp.call('GET', '/admin/site-feedback/item', { query: { cwd: CWD, id: 'FB-AB123' } });
  expect(r.status).toBe(404);
  expect(r.body).toEqual({ ok: false, error: 'not_found' });
});

test.each([['FB-ab123'], ['FB-1234'], ['XX-12345'], ['']])('item rejects id %j', async (id) => {
  const { adminHttp, service } = setup();
  const r = await adminHttp.call('GET', '/admin/site-feedback/item', { query: { cwd: CWD, id } });
  expect(r.status).toBe(400);
  expect(r.body.error).toMatch(/FB-XXXXX/);
  expect(service.calls).toEqual([]);
});

// ── status
test('status delegates id as hostId with note', async () => {
  const { adminHttp, service } = setup();
  const r = await adminHttp.call('POST', '/admin/site-feedback/status', {
    body: { cwd: CWD, id: 'FB-AB123', status: 'resolved', note: 'fixed' },
  });
  expect(r.body).toEqual({ ok: true, meta: { hostId: 'FB-AB123', status: 'resolved', statusNote: 'fixed' } });
  await adminHttp.call('POST', '/admin/site-feedback/status', { body: { cwd: CWD, id: 'FB-AB123', status: 'open' } });
  expect(service.calls).toEqual([
    ['setStatus', { cwd: CWD, hostId: 'FB-AB123', status: 'resolved', note: 'fixed' }],
    ['setStatus', { cwd: CWD, hostId: 'FB-AB123', status: 'open', note: null }],
  ]);
});

test.each([
  ['relative cwd', { cwd: 'x', id: 'FB-AB123', status: 'open' }, /absolute/],
  ['bad id', { cwd: CWD, id: 'nope', status: 'open' }, /FB-XXXXX/],
  ['bad status', { cwd: CWD, id: 'FB-AB123', status: 'closed' }, /status must be one of/],
  ['non-string note', { cwd: CWD, id: 'FB-AB123', status: 'open', note: 5 }, /note/],
  ['long note', { cwd: CWD, id: 'FB-AB123', status: 'open', note: 'x'.repeat(501) }, /note/],
])('status rejects %s', async (_n, body, re) => {
  const { adminHttp, service } = setup();
  const r = await adminHttp.call('POST', '/admin/site-feedback/status', { body });
  expect(r.status).toBe(400);
  expect(r.body.ok).toBe(false);
  expect(r.body.error).toMatch(re);
  expect(service.calls).toEqual([]);
});

test.each([
  ['an unknown cwd', '/home/u/other'],
  ['the home directory', os.homedir()],
  ['an ancestor of a project', '/home/u'],
])('inbox, item and status answer 404 unknown_project for %s before any inbox call', async (_n, cwd) => {
  const { adminHttp, service } = setup();
  const calls = [
    adminHttp.call('GET', '/admin/site-feedback/inbox', { query: { cwd } }),
    adminHttp.call('GET', '/admin/site-feedback/item', { query: { cwd, id: 'FB-AB123' } }),
    adminHttp.call('POST', '/admin/site-feedback/status', { body: { cwd, id: 'FB-AB123', status: 'open' } }),
  ];
  for (const r of await Promise.all(calls)) {
    expect(r.status).toBe(404);
    expect(r.body).toMatchObject({ ok: false, error: 'unknown_project' });
  }
  expect(service.calls).toEqual([]);
});

test('a known project (a box projectCwd) reaches the inbox on all three routes', async () => {
  const { adminHttp, service } = setup();
  expect((await adminHttp.call('GET', '/admin/site-feedback/inbox', { query: { cwd: CWD } })).status).toBe(200);
  expect((await adminHttp.call('GET', '/admin/site-feedback/item', { query: { cwd: CWD, id: 'FB-AB123' } })).status).toBe(200);
  expect((await adminHttp.call('POST', '/admin/site-feedback/status', { body: { cwd: CWD, id: 'FB-AB123', status: 'open' } })).status).toBe(200);
  expect(service.calls.map((c) => c[0])).toEqual(['listItems', 'getItem', 'setStatus']);
});

test('with no boxes at all every inbox route answers 404 unknown_project', async () => {
  const { adminHttp, service } = setup(undefined, []);
  const r = await adminHttp.call('GET', '/admin/site-feedback/inbox', { query: { cwd: CWD } });
  expect(r.status).toBe(404);
  expect(r.body.error).toBe('unknown_project');
  expect(service.calls).toEqual([]);
});

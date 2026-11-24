/**
 * customerFeedbackAdminRoutes.test.cjs — GET /admin/customer-feedback/inbox and
 * POST /admin/customer-feedback/status over a stubbed inbox, and
 * POST /admin/customer-feedback/submit over an injected submit.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/customerFeedbackAdminRoutes.test.cjs
 */
'use strict';

import { test, expect } from 'vitest';
const { registerAdminRoute } = require('../lib/feedback-remote/customerFeedbackAdminRoutes.cjs');

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

function makeInbox(over = {}) {
  const calls = [];
  const inbox = {
    STATUSES: ['open', 'in_progress', 'resolved', 'wontfix'],
    calls,
    async pull() { calls.push(['pull']); return { ok: true, fetched: 2, pages: 1 }; },
    async list(opts) { calls.push(['list', opts]); return { ok: true, items: [{ id: 'a' }] }; },
    async setStatus(id, status, note) { calls.push(['setStatus', id, status, note]); return { ok: true, item: { id, status } }; },
    ...over,
  };
  return inbox;
}

function setup(over) {
  const adminHttp = makeFakeAdminHttp();
  const inbox = makeInbox(over);
  registerAdminRoute(adminHttp, { inbox });
  return { adminHttp, inbox };
}

test('registers all three routes', () => {
  const { adminHttp } = setup();
  expect([...adminHttp.routes.keys()]).toEqual([
    'GET /admin/customer-feedback/inbox',
    'POST /admin/customer-feedback/status',
    'POST /admin/customer-feedback/submit',
  ]);
});

test('inbox without pull does not pull and omits pulled', async () => {
  const { adminHttp, inbox } = setup();
  const r = await adminHttp.call('GET', '/admin/customer-feedback/inbox');
  expect(r.status).toBe(200);
  expect(r.body).toEqual({ ok: true, items: [{ id: 'a' }] });
  expect(inbox.calls).toEqual([['list', { includeHidden: false }]]);
});

test('inbox pull=1 pulls first and includeHidden=1 passes through', async () => {
  const { adminHttp, inbox } = setup();
  const r = await adminHttp.call('GET', '/admin/customer-feedback/inbox', { query: { pull: '1', includeHidden: '1' } });
  expect(r.body.ok).toBe(true);
  expect(r.body.pulled).toEqual({ fetched: 2, pages: 1 });
  expect(inbox.calls).toEqual([['pull'], ['list', { includeHidden: true }]]);
});

test('inbox not-configured error passes through without leaking a token', async () => {
  const { adminHttp } = setup({ list: async () => ({ ok: false, error: 'Not configured as owner.' }) });
  const r = await adminHttp.call('GET', '/admin/customer-feedback/inbox');
  expect(r.body).toEqual({ ok: false, error: 'Not configured as owner.' });
});

test('inbox pull failure short-circuits with the error', async () => {
  const { adminHttp, inbox } = setup({ pull: async () => ({ ok: false, error: 'network down' }) });
  const r = await adminHttp.call('GET', '/admin/customer-feedback/inbox', { query: { pull: '1' } });
  expect(r.body).toEqual({ ok: false, error: 'network down' });
  expect(inbox.calls).toEqual([]);
});

test('status forwards id/status/note to inbox.setStatus', async () => {
  const { adminHttp, inbox } = setup();
  const r = await adminHttp.call('POST', '/admin/customer-feedback/status', { body: { id: 'a', status: 'resolved', note: 'done' } });
  expect(r.status).toBe(200);
  expect(r.body).toEqual({ ok: true, item: { id: 'a', status: 'resolved' } });
  expect(inbox.calls).toEqual([['setStatus', 'a', 'resolved', 'done']]);
});

test('status validation: 400 on bad JSON, missing id, bad status, bad note', async () => {
  const { adminHttp, inbox } = setup();
  const url = '/admin/customer-feedback/status';
  for (const call of [
    { rawBody: '{nope' },
    { body: { status: 'open' } },
    { body: { id: 'a', status: 'bogus' } },
    { body: { id: 'a', status: 'open', note: 5 } },
  ]) {
    const r = await adminHttp.call('POST', url, call);
    expect(r.status).toBe(400);
    expect(r.body.ok).toBe(false);
    expect(typeof r.body.error).toBe('string');
  }
  expect(inbox.calls).toEqual([]);
});

test('status not-configured error passes through', async () => {
  const { adminHttp } = setup({ setStatus: async () => ({ ok: false, error: 'Not configured as owner.' }) });
  const r = await adminHttp.call('POST', '/admin/customer-feedback/status', { body: { id: 'a', status: 'open' } });
  expect(r.body).toEqual({ ok: false, error: 'Not configured as owner.' });
});

// ── POST /admin/customer-feedback/submit ─────────────────────────────────────
const os = require('os');

function setupSubmit(result = { ok: true, item: { id: 'f1', receipt: 'r1' } }) {
  const adminHttp = makeFakeAdminHttp();
  const calls = [];
  const submit = async (p) => { calls.push(p); return typeof result === 'function' ? result(p) : result; };
  registerAdminRoute(adminHttp, { inbox: makeInbox(), submit });
  return { adminHttp, calls };
}

test('registers the submit route', () => {
  const { adminHttp } = setupSubmit();
  expect(adminHttp.routes.has('POST /admin/customer-feedback/submit')).toBe(true);
});

test('submit forwards home-redacted title/body/tag to the injected submit', async () => {
  const home = os.homedir();
  const { adminHttp, calls } = setupSubmit();
  const r = await adminHttp.call('POST', '/admin/customer-feedback/submit', {
    body: { title: `Crash in ${home}/x`, body: `see ${home}/a.log and ${home}/b.log`, tag: 'bug' },
  });
  expect(r.status).toBe(200);
  expect(r.body).toEqual({ ok: true, item: { id: 'f1', receipt: 'r1' } });
  expect(calls).toEqual([{ title: 'Crash in ~/x', body: 'see ~/a.log and ~/b.log', tag: 'bug' }]);
});

test('submit validation: invalid tag, over-length title, bad JSON give 400 with no submit call', async () => {
  const { adminHttp, calls } = setupSubmit();
  const url = '/admin/customer-feedback/submit';
  for (const call of [
    { body: { title: 't', body: 'b', tag: 'praise' } },
    { body: { title: 'x'.repeat(121), body: 'b', tag: 'bug' } },
    { body: { title: 't', body: 'x'.repeat(5001), tag: 'feature' } },
    { rawBody: '{nope' },
  ]) {
    const r = await adminHttp.call('POST', url, call);
    expect(r.status).toBe(400);
    expect(r.body.ok).toBe(false);
    expect(typeof r.body.error).toBe('string');
  }
  expect(calls).toEqual([]);
});

test('submit error passes through as { ok: false, error } with a non-2xx status', async () => {
  const { adminHttp } = setupSubmit({ ok: false, error: 'Too many submissions — try again in a minute.' });
  const r = await adminHttp.call('POST', '/admin/customer-feedback/submit', { body: { title: 't', body: 'secret body', tag: 'discussion' } });
  expect(r.status).toBeGreaterThanOrEqual(400);
  expect(r.body).toEqual({ ok: false, error: 'Too many submissions — try again in a minute.' });
  expect(JSON.stringify(r.body)).not.toContain('secret body');
});

test('a throwing submit never throws out of the handler', async () => {
  const { adminHttp } = setupSubmit(() => { throw new Error('boom'); });
  const r = await adminHttp.call('POST', '/admin/customer-feedback/submit', { body: { title: 't', body: 'b', tag: 'bug' } });
  expect(r.status).toBeGreaterThanOrEqual(500);
  expect(r.body).toEqual({ ok: false, error: 'boom' });
});

test('submit forwards absolute imagePaths to the injected submit', async () => {
  const { adminHttp, calls } = setupSubmit();
  const r = await adminHttp.call('POST', '/admin/customer-feedback/submit', {
    body: { title: 't', body: 'b', tag: 'bug', imagePaths: ['/tmp/a.png', '/tmp/b.jpg'] },
  });
  expect(r.status).toBe(200);
  expect(calls).toEqual([{ title: 't', body: 'b', tag: 'bug', imagePaths: ['/tmp/a.png', '/tmp/b.jpg'] }]);
});

test('submit refuses a relative imagePaths entry with 400 before any submit', async () => {
  const { adminHttp, calls } = setupSubmit();
  const r = await adminHttp.call('POST', '/admin/customer-feedback/submit', {
    body: { title: 't', body: 'b', tag: 'bug', imagePaths: ['/tmp/a.png', 'rel/b.png'] },
  });
  expect(r.status).toBe(400);
  expect(r.body).toEqual({ ok: false, error: 'imagePaths must be absolute paths' });
  expect(calls).toEqual([]);
});

test('submit success passes the submit warning through', async () => {
  const warning = 'Only 1 of 2 images were accepted by the feedback service.';
  const { adminHttp } = setupSubmit({ ok: true, item: { id: 'f1' }, warning });
  const r = await adminHttp.call('POST', '/admin/customer-feedback/submit', {
    body: { title: 't', body: 'b', tag: 'bug', imagePaths: ['/tmp/a.png'] },
  });
  expect(r.status).toBe(200);
  expect(r.body).toEqual({ ok: true, item: { id: 'f1' }, warning });
});

const CONTEXT = {
  page: { url: 'https://x.test/a', title: 'A', viewport: { width: 800, height: 600, devicePixelRatio: 1, scrollX: 0, scrollY: 0 } },
  marks: [{ kind: 'box', n: 1, x: 1, y: 2, w: 10, h: 10, color: '#f4b942', note: '' }],
  console: null,
  network: [{ method: 'POST', url: 'https://x.test/api', status: 'timeout', durationMs: 30000, timestamp: '2026-11-23T10:41:58.010Z' }],
  client: { captureError: 'x' },
};

test('submit forwards a validated context round trip', async () => {
  const { adminHttp, calls } = setupSubmit();
  const r = await adminHttp.call('POST', '/admin/customer-feedback/submit', { body: { title: 't', body: 'b', tag: 'bug', context: CONTEXT } });
  expect(r.status).toBe(200);
  expect(calls).toEqual([{ title: 't', body: 'b', tag: 'bug', context: CONTEXT }]);
});

test('submit refuses an oversize or invalid context with 400 before any submit', async () => {
  const { adminHttp, calls } = setupSubmit();
  const oversize = { ...CONTEXT, page: { ...CONTEXT.page, url: 'u'.repeat(262144) } };
  for (const context of [oversize, { ...CONTEXT, marks: [{ kind: 'nope' }] }, { bogus: true }]) {
    const r = await adminHttp.call('POST', '/admin/customer-feedback/submit', { body: { title: 't', body: 'b', tag: 'bug', context } });
    expect(r.status).toBe(400);
    expect(r.body.ok).toBe(false);
    expect(r.body.error).toMatch(/^invalid submission: context/);
  }
  expect(calls).toEqual([]);
});

test('submit accepts a 5000-char body', async () => {
  const { adminHttp, calls } = setupSubmit();
  const body = 'b'.repeat(5000);
  const r = await adminHttp.call('POST', '/admin/customer-feedback/submit', { body: { title: 't', body, tag: 'feature' } });
  expect(r.status).toBe(200);
  expect(calls[0].body).toBe(body);
});

/**
 * customerFeedbackAdminRoutes.test.cjs — GET /admin/customer-feedback/inbox and
 * POST /admin/customer-feedback/status over a stubbed inbox.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/customerFeedbackAdminRoutes.test.cjs
 */
'use strict';

import { test, expect } from 'vitest';
const { registerAdminRoute } = require('../lib/customerFeedbackAdminRoutes.cjs');

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

test('registers both routes', () => {
  const { adminHttp } = setup();
  expect([...adminHttp.routes.keys()]).toEqual([
    'GET /admin/customer-feedback/inbox',
    'POST /admin/customer-feedback/status',
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

/**
 * needsYouAdminRoutes.test.cjs — lib/feedback-remote/needsYouAdminRoutes.cjs's
 * three routes (POST /admin/needs-you, POST /admin/needs-you/withdraw,
 * GET /admin/needs-you) over a temp SM_SCHEDULER_HOME, so the real
 * needsYouStore and audit log are written under a throwaway dir.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/needsYouAdminRoutes.test.cjs
 */

'use strict';

import { test, expect, beforeEach, afterEach } from 'vitest';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

let prevHome;
let tmpHome;
let routes;
let changed;

/** Fake adminHttp stub: captures registered routes and invokes one directly. */
function makeFakeAdminHttp() {
  const map = new Map();
  return {
    registerRoute(method, url, handler) {
      map.set(`${method} ${url}`, handler);
    },
    async call(method, url, { rawBody, body, query } = {}) {
      const handler = map.get(`${method} ${url}`);
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
      await handler(req, res, new URLSearchParams(query || {}));
      return { status, body: payload };
    },
  };
}

function auditRows(kind) {
  const { auditLogPath } = require('../lib/scheduler/schedulerPaths.cjs');
  let text = '';
  try { text = fs.readFileSync(auditLogPath(), 'utf8'); } catch { return []; }
  return text.split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.kind === kind);
}

beforeEach(async () => {
  prevHome = process.env.SM_SCHEDULER_HOME;
  tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-needs-you-admin-'));
  process.env.SM_SCHEDULER_HOME = tmpHome;
  const { needsYouPath, auditLogPath } = require('../lib/scheduler/schedulerPaths.cjs');
  if (!needsYouPath().startsWith(tmpHome) || !auditLogPath().startsWith(tmpHome)) {
    throw new Error('refusing to run: store or audit log not under temp SM_SCHEDULER_HOME');
  }
  changed = 0;
  routes = makeFakeAdminHttp();
  require('../lib/feedback-remote/needsYouAdminRoutes.cjs').registerAdminRoute(routes, {
    onChanged: () => { changed++; },
  });
});

afterEach(async () => {
  if (prevHome === undefined) delete process.env.SM_SCHEDULER_HOME;
  else process.env.SM_SCHEDULER_HOME = prevHome;
  await fsp.rm(tmpHome, { recursive: true, force: true });
});

const POST = { app: 'portfolio', id: 'q-1', title: 'Ship it?', options: ['yes', 'no'], externalRef: 'portfolio:q-1' };

test('POST /admin/needs-you creates an item: 200, audit row, one onChanged', async () => {
  const r = await routes.call('POST', '/admin/needs-you', { body: POST });
  expect(r.status).toBe(200);
  expect(r.body.ok).toBe(true);
  expect(r.body.created).toBe(true);
  expect(r.body.item).toMatchObject({ app: 'portfolio', id: 'q-1', title: 'Ship it?', status: 'open' });
  expect(changed).toBe(1);
  const rows = auditRows('needs_you_posted');
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ app: 'portfolio', id: 'q-1', externalRef: 'portfolio:q-1', created: true });
});

test('POST /admin/needs-you with only app, id, title: 200, created, externalRef null', async () => {
  const r = await routes.call('POST', '/admin/needs-you', { body: { app: 'portfolio', id: 'q-min', title: 'Ship it?' } });
  expect(r.status).toBe(200);
  expect(r.body).toMatchObject({ ok: true, created: true, item: { app: 'portfolio', id: 'q-min', externalRef: null } });
  expect(r.body.item.externalRef).toBeNull();
});

test('POST /admin/needs-you updating an open item: created false, audit row, onChanged', async () => {
  await routes.call('POST', '/admin/needs-you', { body: POST });
  const r = await routes.call('POST', '/admin/needs-you', { body: { ...POST, title: 'Ship it now?' } });
  expect(r.status).toBe(200);
  expect(r.body).toMatchObject({ ok: true, created: false, item: { title: 'Ship it now?' } });
  expect(changed).toBe(2);
  const rows = auditRows('needs_you_posted');
  expect(rows).toHaveLength(2);
  expect(rows[1]).toMatchObject({ app: 'portfolio', id: 'q-1', created: false });
});

test('POST /admin/needs-you that changes nothing writes no row and no onChanged', async () => {
  await routes.call('POST', '/admin/needs-you', { body: POST });
  const same = await routes.call('POST', '/admin/needs-you', { body: POST });
  expect(same.status).toBe(200);
  expect(same.body).toMatchObject({ ok: true, created: false });
  await routes.call('POST', '/admin/needs-you/withdraw', { body: { app: 'portfolio', id: 'q-1' } });
  const closed = await routes.call('POST', '/admin/needs-you', { body: { ...POST, title: 'Again?' } });
  expect(closed.status).toBe(200);
  expect(closed.body).toMatchObject({ ok: true, created: false, item: { status: 'withdrawn', title: 'Ship it?' } });
  expect(changed).toBe(2); // the create + the withdrawal only
  expect(auditRows('needs_you_posted')).toHaveLength(1);
});

test('POST /admin/needs-you answer carries changed; identical re-post: changed false, no row', async () => {
  const first = await routes.call('POST', '/admin/needs-you', { body: POST });
  expect(first.body).toMatchObject({ ok: true, created: true, changed: true });
  const same = await routes.call('POST', '/admin/needs-you', { body: POST });
  expect(same.body).toMatchObject({ ok: true, created: false, changed: false });
  expect(auditRows('needs_you_posted')).toHaveLength(1);
  expect(changed).toBe(1);
});

test('POST /admin/needs-you with another externalRef stores it and logs it', async () => {
  await routes.call('POST', '/admin/needs-you', { body: POST });
  const r = await routes.call('POST', '/admin/needs-you', { body: { ...POST, externalRef: 'portfolio:q-1b' } });
  expect(r.body).toMatchObject({ ok: true, created: false, changed: true, item: { externalRef: 'portfolio:q-1b' } });
  const rows = auditRows('needs_you_posted');
  expect(rows).toHaveLength(2);
  expect(rows[1]).toMatchObject({ externalRef: 'portfolio:q-1b', created: false });
  const list = await routes.call('GET', '/admin/needs-you', { query: { app: 'portfolio' } });
  expect(list.body.items[0].externalRef).toBe('portfolio:q-1b');
});

test('two POSTs issued together: at most one audit row per real change', async () => {
  await routes.call('POST', '/admin/needs-you', { body: POST });
  const next = { ...POST, title: 'Ship it today?' };
  const [a, b] = await Promise.all([
    routes.call('POST', '/admin/needs-you', { body: next }),
    routes.call('POST', '/admin/needs-you', { body: next }),
  ]);
  expect([a.body.changed, b.body.changed].filter(Boolean)).toHaveLength(1);
  expect(auditRows('needs_you_posted')).toHaveLength(2);
  expect(changed).toBe(2);
});

test('POST /admin/needs-you invalid input: 400 with the first problem in words', async () => {
  const r = await routes.call('POST', '/admin/needs-you', { body: { ...POST, app: 'bad app!' } });
  expect(r.status).toBe(400);
  expect(r.body).toEqual({ ok: false, error: 'app must be 1 to 40 letters, digits, . _ or -' });
  const bad = await routes.call('POST', '/admin/needs-you', { rawBody: '{nope' });
  expect(bad.status).toBe(400);
  expect(bad.body).toEqual({ ok: false, error: 'invalid JSON body' });
  expect(changed).toBe(0);
  expect(auditRows('needs_you_posted')).toHaveLength(0);
});

test('POST /admin/needs-you over the item limit: 429', async () => {
  const { MAX_OPEN_PER_APP } = require('../lib/feedback-remote/needsYouStore.cjs');
  for (let i = 0; i < MAX_OPEN_PER_APP; i++) {
    const r = await routes.call('POST', '/admin/needs-you', { body: { app: 'portfolio', id: `n-${i}`, title: `Q ${i}` } });
    expect(r.status).toBe(200);
  }
  const r = await routes.call('POST', '/admin/needs-you', { body: { app: 'portfolio', id: 'over', title: 'One too many' } });
  expect(r.status).toBe(429);
  expect(r.body.ok).toBe(false);
  expect(typeof r.body.error).toBe('string');
  expect(r.body.error.length).toBeGreaterThan(0);
  expect(changed).toBe(MAX_OPEN_PER_APP);
});

test('POST /admin/needs-you/withdraw: 200 with the item, audit row, onChanged', async () => {
  await routes.call('POST', '/admin/needs-you', { body: POST });
  const r = await routes.call('POST', '/admin/needs-you/withdraw', { body: { app: 'portfolio', id: 'q-1' } });
  expect(r.status).toBe(200);
  expect(r.body).toMatchObject({ ok: true, item: { app: 'portfolio', id: 'q-1', status: 'withdrawn' } });
  expect(changed).toBe(2);
  const rows = auditRows('needs_you_withdrawn');
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ app: 'portfolio', id: 'q-1' });
});

test('POST /admin/needs-you/withdraw with no open match: 404, no row, no onChanged', async () => {
  const r = await routes.call('POST', '/admin/needs-you/withdraw', { body: { app: 'portfolio', id: 'missing' } });
  expect(r.status).toBe(404);
  expect(r.body).toEqual({ ok: false, error: 'not found' });
  expect(changed).toBe(0);
  expect(auditRows('needs_you_withdrawn')).toHaveLength(0);
});

test('POST /admin/needs-you/withdraw invalid input: 400', async () => {
  const r = await routes.call('POST', '/admin/needs-you/withdraw', { body: { app: 'portfolio' } });
  expect(r.status).toBe(400);
  expect(r.body).toEqual({ ok: false, error: 'id is required.' });
});

test('GET /admin/needs-you lists items, filtered by app and status', async () => {
  await routes.call('POST', '/admin/needs-you', { body: POST });
  await routes.call('POST', '/admin/needs-you', { body: { app: 'kiln', id: 'k-1', title: 'Kiln Q' } });
  await routes.call('POST', '/admin/needs-you/withdraw', { body: { app: 'kiln', id: 'k-1' } });
  const before = changed;

  const all = await routes.call('GET', '/admin/needs-you');
  expect(all.status).toBe(200);
  expect(all.body.ok).toBe(true);
  expect(all.body.items.map((i) => i.id).sort()).toEqual(['k-1', 'q-1']);

  const byApp = await routes.call('GET', '/admin/needs-you', { query: { app: 'kiln' } });
  expect(byApp.body).toMatchObject({ ok: true, items: [{ id: 'k-1' }] });

  const open = await routes.call('GET', '/admin/needs-you', { query: { status: 'open' } });
  expect(open.body.items.map((i) => i.id)).toEqual(['q-1']);

  const bad = await routes.call('GET', '/admin/needs-you', { query: { status: 'nope' } });
  expect(bad.status).toBe(400);
  expect(bad.body.ok).toBe(false);
  expect(changed).toBe(before);
});

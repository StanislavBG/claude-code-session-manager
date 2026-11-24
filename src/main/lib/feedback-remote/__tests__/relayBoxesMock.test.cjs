/**
 * relayBoxesMock.test.cjs — exercises every route and status of the relay drop-box mock
 * (Host contract v1, session-manager-operations/architecture/site-feedback.md).
 *
 * Run: timeout 300 npx vitest run src/main/lib/feedback-remote/__tests__/relayBoxesMock.test.cjs
 */
'use strict';

import { test, expect, afterEach } from 'vitest';
const crypto = require('node:crypto');
const { startRelayBoxesMock } = require('./helpers/relayBoxesMock.cjs');

const DEV = 'dev-token-abc';
const CLERK = 'clerk-session-xyz';
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const ORIGIN = 'https://site.example';

/** @type {Array<{ stop: () => Promise<unknown> }>} */
const mocks = [];
afterEach(async () => {
  while (mocks.length) await /** @type {any} */ (mocks.pop()).stop();
});

/** @param {any} [opts] */
async function start(opts = {}) {
  const m = await startRelayBoxesMock({ deviceToken: DEV, clerkToken: CLERK, ...opts });
  mocks.push(m);
  return m;
}

function pubKey() {
  const { publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  return Buffer.concat([
    Buffer.from([4]),
    Buffer.from(/** @type {string} */ (jwk.x), 'base64url'),
    Buffer.from(/** @type {string} */ (jwk.y), 'base64url'),
  ]).toString('base64url');
}

/** @param {string} [tok] */
const authH = (tok = DEV) => ({ Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' });

/** @param {any} m @param {any} [over] @param {any} [headers] */
async function createBox(m, over = {}, headers = authH()) {
  const r = await fetch(`${m.baseUrl}/boxes`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ label: 'Site', publicKey: pubKey(), allowedOrigins: [ORIGIN], ...over }),
  });
  return { status: r.status, body: await r.json() };
}

/** @param {any} m @param {string} boxId @param {any} [o] */
async function submit(m, boxId, o = {}) {
  /** @type {Record<string, string>} */
  const headers = {
    'Content-Type': 'application/octet-stream',
    'X-Sm-Envelope': '1',
    'X-Sm-Report-Id': o.reportId ?? crypto.randomUUID(),
    'X-Test-Ip': o.ip ?? '10.0.0.1',
  };
  if (o.origin !== null) headers.Origin = o.origin ?? ORIGIN;
  Object.assign(headers, o.headers || {});
  const r = await fetch(`${m.baseUrl}/boxes/${boxId}/envelopes`, {
    method: 'POST',
    headers,
    body: o.body ?? Buffer.from('SMF1sealed-bytes'),
  });
  const text = await r.text();
  return { r, status: r.status, body: text ? JSON.parse(text) : null };
}

test('starts on 127.0.0.1 with a random port and stops', async () => {
  const m = await start();
  expect(m.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  const m2 = await start();
  expect(m2.baseUrl).not.toBe(m.baseUrl);
});

test('auth: 401 missing_token / invalid_token', async () => {
  const m = await start();
  let r = await fetch(`${m.baseUrl}/boxes`);
  expect(r.status).toBe(401);
  expect(await r.json()).toEqual({ error: 'missing_token' });
  r = await fetch(`${m.baseUrl}/boxes`, { headers: authH('nope') });
  expect(r.status).toBe(401);
  expect(await r.json()).toEqual({ error: 'invalid_token' });
});

test('auth: owner gate 403 not_enabled when X-Test-Email outside allowEmails', async () => {
  const m = await start({ allowEmails: ['owner@example.com'] });
  const bad = await createBox(m, {}, { ...authH(), 'X-Test-Email': 'other@example.com' });
  expect(bad).toEqual({ status: 403, body: { error: 'not_enabled' } });
  const none = await createBox(m);
  expect(none).toEqual({ status: 403, body: { error: 'not_enabled' } });
  const ok = await createBox(m, {}, { ...authH(), 'X-Test-Email': 'Owner@example.com' });
  expect(ok.status).toBe(201);
});

test('auth: 403 not_allowed for another account box', async () => {
  const m = await start();
  m.state.boxes.set('FOREIGN1', {
    boxId: 'FOREIGN1', label: 'x', allowedOrigins: [ORIGIN], publicKey: pubKey(), state: 'open',
    createdAt: new Date().toISOString(), lastReceivedAt: null, deviceId: 'dev-other', accountId: 'other',
  });
  for (const [method, path] of [['PATCH', ''], ['DELETE', ''], ['GET', '/envelopes']]) {
    const r = await fetch(`${m.baseUrl}/boxes/FOREIGN1${path}`, { method, headers: authH(), body: method === 'PATCH' ? '{}' : undefined });
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ error: 'not_allowed' });
  }
  const list = await (await fetch(`${m.baseUrl}/boxes`, { headers: authH() })).json();
  expect(list.boxes).toEqual([]);
});

test('auth: clerk bearer refused on POST /boxes and drain routes, accepted on GET/PATCH/DELETE', async () => {
  const m = await start();
  expect(await createBox(m, {}, authH(CLERK))).toEqual({ status: 403, body: { error: 'device_token_required' } });
  const { body } = await createBox(m);
  const id = body.boxId;
  for (const [method, path] of [['GET', '/envelopes'], ['GET', '/envelopes/x'], ['DELETE', '/envelopes/x']]) {
    const r = await fetch(`${m.baseUrl}/boxes/${id}${path}`, { method, headers: authH(CLERK) });
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ error: 'device_token_required' });
  }
  expect((await fetch(`${m.baseUrl}/boxes`, { headers: authH(CLERK) })).status).toBe(200);
  const p = await fetch(`${m.baseUrl}/boxes/${id}`, { method: 'PATCH', headers: authH(CLERK), body: JSON.stringify({ label: 'New' }) });
  expect(p.status).toBe(200);
  expect((await p.json()).label).toBe('New');
  expect((await fetch(`${m.baseUrl}/boxes/${id}`, { method: 'DELETE', headers: authH(CLERK) })).status).toBe(200);
});

test('auth: 403 box_limit_reached past maxBoxesPerAccount', async () => {
  const m = await start({ maxBoxesPerAccount: 2 });
  expect((await createBox(m)).status).toBe(201);
  expect((await createBox(m)).status).toBe(201);
  expect(await createBox(m)).toEqual({ status: 403, body: { error: 'box_limit_reached' } });
});

test('POST /boxes validates label, publicKey, allowedOrigins and returns 201', async () => {
  const m = await start();
  const ok = await createBox(m);
  expect(ok.status).toBe(201);
  expect(ok.body.boxId).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/);
  expect(ok.body.state).toBe('open');
  expect(ok.body.createdAt).toMatch(ISO_RE);

  for (const label of ['', 'x'.repeat(81), 5, undefined])
    expect((await createBox(m, { label })).body).toEqual({ error: 'invalid_label' });
  expect((await createBox(m, { label: 'x'.repeat(80) })).status).toBe(201);

  const notOnCurve = Buffer.concat([Buffer.from([4]), Buffer.alloc(32, 1), Buffer.alloc(32, 2)]).toString('base64url');
  const compressed = Buffer.concat([Buffer.from([2]), Buffer.alloc(64, 1)]).toString('base64url');
  for (const publicKey of [notOnCurve, compressed, 'short', 'not base64!', 42])
    expect((await createBox(m, { publicKey })).body).toEqual({ error: 'invalid_public_key' });

  const badOrigins = [
    [], 'https://a.com', ['https://a.com/'], ['http://a.com'], ['ftp://a.com'], ['https://a.com', 'https://a.com'],
    Array.from({ length: 11 }, (_, i) => `https://s${i}.com`), ['not a url'], ['https://A.com'], ['https://a.com:443'],
  ];
  for (const allowedOrigins of badOrigins)
    expect((await createBox(m, { allowedOrigins })).body).toEqual({ error: 'invalid_allowed_origins' });
  const goodOrigins = ['https://a.com', 'https://b.com:8443', 'http://localhost', 'http://localhost:5173', 'http://127.0.0.1:8080'];
  expect((await createBox(m, { allowedOrigins: goodOrigins })).status).toBe(201);
});

test('GET /boxes lists the full box shape', async () => {
  const m = await start();
  const pk = pubKey();
  const { body } = await createBox(m, { publicKey: pk, label: 'L' });
  await submit(m, body.boxId);
  const r = await fetch(`${m.baseUrl}/boxes`, { headers: authH() });
  const { boxes } = await r.json();
  expect(boxes).toHaveLength(1);
  const b = boxes[0];
  expect(Object.keys(b).sort()).toEqual(
    ['allowedOrigins', 'boxId', 'createdAt', 'deviceId', 'label', 'lastReceivedAt', 'pending', 'pendingBytes', 'publicKey', 'state'].sort(),
  );
  expect(b).toMatchObject({ boxId: body.boxId, label: 'L', allowedOrigins: [ORIGIN], publicKey: pk, state: 'open', pending: 1, pendingBytes: 16 });
  expect(b.createdAt).toMatch(ISO_RE);
  expect(b.lastReceivedAt).toMatch(ISO_RE);
  expect(typeof b.deviceId).toBe('string');
});

test('PATCH validates state and other fields; deleted box answers 404 everywhere', async () => {
  const m = await start();
  const { body } = await createBox(m);
  const id = body.boxId;
  const patch = (/** @type {any} */ b) => fetch(`${m.baseUrl}/boxes/${id}`, { method: 'PATCH', headers: authH(), body: JSON.stringify(b) });
  let r = await patch({ state: 'closed' });
  expect(r.status).toBe(400);
  expect(await r.json()).toEqual({ error: 'invalid_state' });
  r = await patch({ label: '' });
  expect(await r.json()).toEqual({ error: 'invalid_label' });
  r = await patch({ allowedOrigins: ['http://evil.com'] });
  expect(await r.json()).toEqual({ error: 'invalid_allowed_origins' });
  r = await patch({ state: 'paused' });
  expect(r.status).toBe(200);
  expect((await r.json()).state).toBe('paused');
  r = await patch({ state: 'open' });
  expect((await r.json()).state).toBe('open');

  r = await fetch(`${m.baseUrl}/boxes/${id}`, { method: 'DELETE', headers: authH() });
  expect(r.status).toBe(200);
  const checks = [
    fetch(`${m.baseUrl}/boxes/${id}`, { method: 'PATCH', headers: authH(), body: '{}' }),
    fetch(`${m.baseUrl}/boxes/${id}`, { method: 'DELETE', headers: authH() }),
    fetch(`${m.baseUrl}/boxes/${id}/envelopes`, { headers: authH() }),
    fetch(`${m.baseUrl}/boxes/${id}/envelopes/x`, { headers: authH() }),
    fetch(`${m.baseUrl}/boxes/${id}/envelopes/x`, { method: 'DELETE', headers: authH() }),
    fetch(`${m.baseUrl}/boxes/${id}/key`),
    fetch(`${m.baseUrl}/boxes/${id}/envelopes`, { method: 'OPTIONS', headers: { Origin: ORIGIN } }),
    fetch(`${m.baseUrl}/boxes/${id}/envelopes`, { method: 'POST', headers: { Origin: ORIGIN }, body: 'SMF1' }),
  ];
  for (const res of await Promise.all(checks)) {
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'box_not_found' });
  }
  const list = await (await fetch(`${m.baseUrl}/boxes`, { headers: authH() })).json();
  expect(list.boxes).toEqual([]);
});

test('drain: list oldest first with limit, fetch bytes, ack, 404 envelope_not_found', async () => {
  const m = await start();
  const { body } = await createBox(m);
  const id = body.boxId;
  const ids = [];
  for (let i = 0; i < 3; i++) {
    const s = await submit(m, id, { body: Buffer.from(`SMF1-${i}`), ip: `10.1.0.${i}` });
    expect(s.status).toBe(201);
    ids.push(s.body.id);
  }
  const list = async (/** @type {string} */ q = '') => fetch(`${m.baseUrl}/boxes/${id}/envelopes${q}`, { headers: authH() });
  let r = await list();
  const { envelopes } = await r.json();
  expect(envelopes.map((/** @type {any} */ e) => e.hostId)).toEqual(ids);
  const e0 = envelopes[0];
  expect(Object.keys(e0).sort()).toEqual(['bytes', 'clientReportId', 'envelopeId', 'hostId', 'origin', 'receivedAt']);
  expect(e0.receivedAt).toMatch(ISO_RE);
  expect(e0.origin).toBe(ORIGIN);
  expect(e0.bytes).toBe(6);

  r = await list('?limit=2');
  expect((await r.json()).envelopes).toHaveLength(2);
  for (const q of ['?limit=0', '?limit=21', '?limit=abc', '?limit=']) {
    r = await list(q);
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ error: 'invalid_limit' });
  }

  r = await fetch(`${m.baseUrl}/boxes/${id}/envelopes/${e0.envelopeId}`, { headers: authH() });
  expect(r.status).toBe(200);
  expect(r.headers.get('content-type')).toBe('application/octet-stream');
  expect(r.headers.get('cache-control')).toBe('no-store');
  expect(Buffer.from(await r.arrayBuffer()).toString()).toBe('SMF1-0');

  r = await fetch(`${m.baseUrl}/boxes/${id}/envelopes/${e0.envelopeId}`, { method: 'DELETE', headers: authH() });
  expect(r.status).toBe(200);
  for (const method of ['GET', 'DELETE']) {
    r = await fetch(`${m.baseUrl}/boxes/${id}/envelopes/${e0.envelopeId}`, { method, headers: authH() });
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ error: 'envelope_not_found' });
  }
  expect((await (await list()).json()).envelopes).toHaveLength(2);
});

test('public key route: CORS * and max-age 60', async () => {
  const m = await start();
  const pk = pubKey();
  const { body } = await createBox(m, { publicKey: pk });
  const r = await fetch(`${m.baseUrl}/boxes/${body.boxId}/key`);
  expect(r.status).toBe(200);
  expect(r.headers.get('access-control-allow-origin')).toBe('*');
  expect(r.headers.get('cache-control')).toMatch(/max-age=60/);
  expect(await r.json()).toEqual({ boxId: body.boxId, publicKey: pk, state: 'open' });
  const nf = await fetch(`${m.baseUrl}/boxes/ZZZZZZZZ/key`);
  expect(nf.status).toBe(404);
  expect(await nf.json()).toEqual({ error: 'box_not_found' });
});

test('OPTIONS + POST origin checks', async () => {
  const m = await start();
  const { body } = await createBox(m);
  const url = `${m.baseUrl}/boxes/${body.boxId}/envelopes`;
  for (const headers of [{}, { Origin: 'https://evil.example' }]) {
    const r = await fetch(url, { method: 'OPTIONS', headers });
    expect(r.status).toBe(403);
    expect(r.headers.get('access-control-allow-origin')).toBeNull();
    expect(await r.json()).toEqual({ error: 'origin_not_allowed' });
  }
  const pre = await fetch(url, { method: 'OPTIONS', headers: { Origin: ORIGIN } });
  expect(pre.status).toBe(204);
  expect(pre.headers.get('access-control-allow-origin')).toBe(ORIGIN);
  expect(pre.headers.get('vary')).toBe('Origin');
  const allow = String(pre.headers.get('access-control-allow-headers'));
  for (const h of ['Content-Type', 'X-Sm-Envelope', 'X-Sm-Report-Id']) expect(allow).toContain(h);

  for (const origin of [null, 'https://evil.example']) {
    const s = await submit(m, body.boxId, { origin });
    expect(s.status).toBe(403);
    expect(s.r.headers.get('access-control-allow-origin')).toBeNull();
    expect(s.body).toEqual({ error: 'origin_not_allowed' });
  }
  const ok = await submit(m, body.boxId);
  expect(ok.r.headers.get('access-control-allow-origin')).toBe(ORIGIN);
  expect(ok.r.headers.get('vary')).toBe('Origin');
});

test('POST envelope: header/body validation, 201 id, idempotent report id, 413, 410, 404', async () => {
  const m = await start();
  const { body } = await createBox(m);
  const id = body.boxId;
  let s = await submit(m, id, { headers: { 'X-Sm-Envelope': '2' }, ip: 'a' });
  expect(s).toMatchObject({ status: 400, body: { error: 'bad_envelope' } });
  s = await submit(m, id, { reportId: 'not-a-uuid', ip: 'b' });
  expect(s).toMatchObject({ status: 400, body: { error: 'invalid_report_id' } });
  s = await submit(m, id, { reportId: '00000000-0000-0000-0000-000000000000', ip: 'b2' });
  expect(s.status).toBe(201);
  s = await submit(m, id, { headers: { 'Content-Type': 'text/plain' }, ip: 'b3' });
  expect(s).toMatchObject({ status: 400, body: { error: 'bad_envelope' } });
  s = await submit(m, id, { body: Buffer.from('XXXXhello'), ip: 'c' });
  expect(s).toMatchObject({ status: 400, body: { error: 'bad_envelope' } });
  s = await submit(m, id, { body: Buffer.alloc(12 * 1024 * 1024 + 1, 'S'), ip: 'd' });
  expect(s.status).toBe(413);

  const big = Buffer.alloc(12 * 1024 * 1024);
  big.write('SMF1');
  s = await submit(m, id, { body: big, ip: 'e' });
  expect(s.status).toBe(201);

  const reportId = crypto.randomUUID();
  const first = await submit(m, id, { reportId, ip: 'f' });
  expect(first.status).toBe(201);
  expect(first.body.id).toMatch(/^FB-[0-9A-HJKMNP-TV-Z]{5}$/);
  const again = await submit(m, id, { reportId, ip: 'f' });
  expect(again).toMatchObject({ status: 200, body: { id: first.body.id } });

  await fetch(`${m.baseUrl}/boxes/${id}`, { method: 'PATCH', headers: authH(), body: JSON.stringify({ state: 'paused' }) });
  s = await submit(m, id, { ip: 'g' });
  expect(s).toMatchObject({ status: 410, body: { error: 'box_paused' } });

  s = await submit(m, 'ZZZZZZZZ', { ip: 'h' });
  expect(s).toMatchObject({ status: 404, body: { error: 'box_not_found' } });
});

test('429 rate_limited per IP (10/min, retries counted) with Retry-After', async () => {
  let t = Date.parse('2026-11-23T12:00:00Z');
  const m = await start({ now: () => t });
  const { body } = await createBox(m);
  const reportId = crypto.randomUUID();
  for (let i = 0; i < 10; i++) expect((await submit(m, body.boxId, { reportId, ip: '1.1.1.1' })).status).toBeLessThan(300);
  const s = await submit(m, body.boxId, { ip: '1.1.1.1' });
  expect(s).toMatchObject({ status: 429, body: { error: 'rate_limited' } });
  expect(Number(s.r.headers.get('retry-after'))).toBeGreaterThan(0);
  expect((await submit(m, body.boxId, { ip: '2.2.2.2' })).status).toBe(201);
  t += 61_000;
  expect((await submit(m, body.boxId, { ip: '1.1.1.1' })).status).toBe(201);
});

test('429 rate_limited per box (60/hour)', async () => {
  let t = Date.parse('2026-11-23T12:00:00Z');
  const m = await start({ now: () => t });
  const { body } = await createBox(m);
  for (let i = 0; i < 60; i++) expect((await submit(m, body.boxId, { ip: `ip-${i}` })).status).toBe(201);
  const s = await submit(m, body.boxId, { ip: 'fresh' });
  expect(s).toMatchObject({ status: 429, body: { error: 'rate_limited' } });
  expect(Number(s.r.headers.get('retry-after'))).toBeGreaterThan(60);
  t += 3_601_000;
  expect((await submit(m, body.boxId, { ip: 'fresh' })).status).toBe(201);
});

test('507 box_full at 500 envelopes or 200 MiB', async () => {
  const m = await start();
  const a = (await createBox(m)).body.boxId;
  const fake = (/** @type {number} */ i, /** @type {number} */ bytes) => ({
    envelopeId: `e${i}`, hostId: `FB-0000${i % 10}`, clientReportId: crypto.randomUUID(),
    receivedAt: new Date().toISOString(), origin: ORIGIN, bytes, body: Buffer.alloc(0),
  });
  m.state.envelopes.set(a, Array.from({ length: 500 }, (_, i) => fake(i, 1)));
  expect(await submit(m, a, { ip: 'x1' })).toMatchObject({ status: 507, body: { error: 'box_full' } });

  const b = (await createBox(m)).body.boxId;
  m.state.envelopes.set(b, [fake(0, 200 * 1024 * 1024)]);
  expect(await submit(m, b, { ip: 'x2' })).toMatchObject({ status: 507, body: { error: 'box_full' } });
});

test('helper requires only node built-ins', () => {
  const src = require('node:fs').readFileSync(require.resolve('./helpers/relayBoxesMock.cjs'), 'utf8');
  const reqs = [...src.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((x) => x[1]);
  expect(reqs.length).toBeGreaterThan(0);
  for (const r of reqs) expect(r.startsWith('node:')).toBe(true);
});

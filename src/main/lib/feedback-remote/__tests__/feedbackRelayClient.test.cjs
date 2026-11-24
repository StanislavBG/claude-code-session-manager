/**
 * feedbackRelayClient.test.cjs — the desktop relay box client against relayBoxesMock.
 *
 * A tiny forwarder stands in for https://bilko.run: it strips the /api/sm-relay prefix the client
 * adds and pipes to the mock, so the client runs with its real path layout.
 * Run: timeout 300 npx vitest run src/main/lib/feedback-remote/__tests__/feedbackRelayClient.test.cjs
 */
'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const { startRelayBoxesMock } = require('./helpers/relayBoxesMock.cjs');
const { createRelayClient } = require('../feedbackRelayClient.cjs');

const TOKEN = 'dtok-SECRET-' + crypto.randomBytes(8).toString('hex');
const CLERK = 'clerk-' + crypto.randomBytes(8).toString('hex');

function publicKey() {
  const { publicKey: pk } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = pk.export({ format: 'jwk' });
  return Buffer.concat([
    Buffer.from([4]),
    Buffer.from(String(jwk.x), 'base64url'),
    Buffer.from(String(jwk.y), 'base64url'),
  ]).toString('base64url');
}

/** @param {string} target */
async function startPrefixProxy(target, extraHeaders = {}) {
  const t = new URL(target);
  const server = http.createServer((req, res) => {
    const path = String(req.url || '/').replace(/^\/api\/sm-relay/, '') || '/';
    const up = http.request(
      { host: t.hostname, port: t.port, method: req.method, path, headers: { ...req.headers, ...extraHeaders } },
      (r) => {
        res.writeHead(r.statusCode || 502, r.headers);
        r.pipe(res);
      },
    );
    up.on('error', () => {
      res.writeHead(502);
      res.end();
    });
    req.pipe(up);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', () => r(undefined)));
  const addr = /** @type {import('node:net').AddressInfo} */ (server.address());
  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    stop: () =>
      new Promise((r) => {
        server.closeAllConnections?.();
        server.close(() => r(undefined));
      }),
  };
}

/** @param {unknown} v */
function expectNoToken(v) {
  expect(JSON.stringify(v)).not.toContain(TOKEN);
}

const ORIGIN = 'https://example.com';

/** Submits an envelope to the mock directly (public route, no prefix). */
async function submit(base, boxId, ip = '1.1.1.1') {
  return fetch(`${base}/boxes/${boxId}/envelopes`, {
    method: 'POST',
    headers: {
      Origin: ORIGIN,
      'X-Sm-Envelope': '1',
      'X-Sm-Report-Id': crypto.randomUUID(),
      'Content-Type': 'application/octet-stream',
      'X-Test-Ip': ip,
    },
    body: Buffer.concat([Buffer.from('SMF1'), crypto.randomBytes(32)]),
  });
}

describe('feedbackRelayClient', () => {
  /** @type {any} */ let mock;
  /** @type {any} */ let proxy;
  /** @type {ReturnType<typeof createRelayClient>} */ let client;

  beforeEach(async () => {
    mock = await startRelayBoxesMock({ deviceToken: TOKEN, clerkToken: CLERK, maxBoxesPerAccount: 2 });
    proxy = await startPrefixProxy(mock.baseUrl);
    client = createRelayClient({ baseUrl: proxy.baseUrl, getDeviceToken: () => TOKEN });
  });
  afterEach(async () => {
    await proxy.stop();
    await mock.stop();
  });

  it('runs the full box lifecycle with the device token under /api/sm-relay', async () => {
    const created = await client.createBox({ label: 'Site', publicKey: publicKey(), allowedOrigins: [ORIGIN] });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.state).toBe('open');
    expect(typeof created.boxId).toBe('string');
    const boxId = /** @type {string} */ (created.boxId);

    const listed = await client.listBoxes();
    expect(listed.ok && listed.boxes.map((b) => b.boxId)).toEqual([boxId]);

    const patched = await client.patchBox(boxId, { label: 'Renamed' });
    expect(patched.ok && patched.box.label).toBe('Renamed');

    expect((await submit(mock.baseUrl, boxId)).status).toBe(201);
    const envs = await client.listEnvelopes(boxId, 5);
    expect(envs.ok).toBe(true);
    if (!envs.ok) return;
    expect(envs.envelopes).toHaveLength(1);
    const envId = envs.envelopes[0].envelopeId;

    const got = await client.getEnvelope(boxId, envId);
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(Buffer.isBuffer(got.body)).toBe(true);
    expect(got.body.subarray(0, 4).toString('latin1')).toBe('SMF1');

    expect(await client.ackEnvelope(boxId, envId)).toEqual({ ok: true });
    const after = await client.listEnvelopes(boxId);
    expect(after.ok && after.envelopes).toEqual([]);

    expect(await client.deleteBox(boxId)).toEqual({ ok: true });

    const owner = mock.state.requests.filter((r) => r.path.startsWith('/boxes') && r.headers.authorization);
    expect(owner.length).toBeGreaterThan(0);
    for (const r of owner) expect(r.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(mock.state.requests.some((r) => r.path === '/boxes/' + boxId + '/envelopes?limit=5')).toBe(true);
  });

  it('passes 401 invalid_token through without leaking the token', async () => {
    const bad = createRelayClient({ baseUrl: proxy.baseUrl, getDeviceToken: () => TOKEN + '-wrong' });
    const results = [
      await bad.createBox({ label: 'x', publicKey: publicKey(), allowedOrigins: [ORIGIN] }),
      await bad.listBoxes(),
      await bad.patchBox('ABCDEFGH', { state: 'paused' }),
      await bad.deleteBox('ABCDEFGH'),
      await bad.listEnvelopes('ABCDEFGH', 1),
      await bad.getEnvelope('ABCDEFGH', 'e'),
      await bad.ackEnvelope('ABCDEFGH', 'e'),
    ];
    for (const r of results) {
      expect(r).toEqual({ ok: false, status: 401, error: 'invalid_token' });
      expect(JSON.stringify(r)).not.toContain(TOKEN);
    }
  });

  it('403 not_enabled outside the owner gate', async () => {
    await proxy.stop();
    await mock.stop();
    mock = await startRelayBoxesMock({ deviceToken: TOKEN, allowEmails: ['owner@example.com'] });
    proxy = await startPrefixProxy(mock.baseUrl, { 'x-test-email': 'someone@else.com' });
    client = createRelayClient({ baseUrl: proxy.baseUrl, getDeviceToken: () => TOKEN });
    const r = await client.createBox({ label: 'x', publicKey: publicKey(), allowedOrigins: [ORIGIN] });
    expect(r).toEqual({ ok: false, status: 403, error: 'not_enabled' });
    expectNoToken(r);
  });

  it('403 device_token_required when the bearer is a Clerk session', async () => {
    const clerk = createRelayClient({ baseUrl: proxy.baseUrl, getDeviceToken: () => CLERK });
    const r = await clerk.createBox({ label: 'x', publicKey: publicKey(), allowedOrigins: [ORIGIN] });
    expect(r).toEqual({ ok: false, status: 403, error: 'device_token_required' });
  });

  it('403 box_limit_reached past the account cap', async () => {
    const mk = () => client.createBox({ label: 'x', publicKey: publicKey(), allowedOrigins: [ORIGIN] });
    expect((await mk()).ok).toBe(true);
    expect((await mk()).ok).toBe(true);
    const r = await mk();
    expect(r).toEqual({ ok: false, status: 403, error: 'box_limit_reached' });
    expectNoToken(r);
  });

  it('404 box_not_found on every box-scoped method', async () => {
    const results = [
      await client.patchBox('NOPE0000', { label: 'y' }),
      await client.deleteBox('NOPE0000'),
      await client.listEnvelopes('NOPE0000', 3),
      await client.getEnvelope('NOPE0000', 'e1'),
      await client.ackEnvelope('NOPE0000', 'e1'),
    ];
    for (const r of results) {
      expect(r).toEqual({ ok: false, status: 404, error: 'box_not_found' });
      expectNoToken(r);
    }
  });

  it('400 host validation codes pass through verbatim', async () => {
    const r = await client.createBox({ label: '', publicKey: publicKey(), allowedOrigins: [ORIGIN] });
    expect(r).toEqual({ ok: false, status: 400, error: 'invalid_label' });
    const c = await client.createBox({ label: 'ok', publicKey: publicKey(), allowedOrigins: [ORIGIN] });
    if (!c.ok) throw new Error('create failed');
    expect(await client.listEnvelopes(/** @type {string} */ (c.boxId), 99)).toEqual({
      ok: false,
      status: 400,
      error: 'invalid_limit',
    });
    expect(await client.getEnvelope(/** @type {string} */ (c.boxId), 'missing')).toEqual({
      ok: false,
      status: 404,
      error: 'envelope_not_found',
    });
  });

  it('410 box_paused, 429 rate_limited with retryAfterSec, 507 box_full', async () => {
    // These come from the public submit route; the client never calls it, so exercise the
    // client's error mapping through a stand-in that replays the mock's real responses.
    const c = await client.createBox({ label: 'ok', publicKey: publicKey(), allowedOrigins: [ORIGIN] });
    if (!c.ok) throw new Error('create failed');
    const boxId = /** @type {string} */ (c.boxId);
    expect((await client.patchBox(boxId, { state: 'paused' })).ok).toBe(true);
    const paused = await submit(mock.baseUrl, boxId, '2.2.2.2');
    expect(paused.status).toBe(410);
    const pausedBody = await paused.text();

    let limited;
    for (let i = 0; i < 12; i++) limited = await submit(mock.baseUrl, boxId, '3.3.3.3');
    expect(limited.status).toBe(429);
    const retryAfter = limited.headers.get('retry-after');
    expect(retryAfter).toMatch(/^\d+$/);
    const limitedBody = await limited.text();

    const replay = {
      '/api/sm-relay/boxes': { status: 410, body: pausedBody, headers: {} },
      [`/api/sm-relay/boxes/${boxId}`]: { status: 429, body: limitedBody, headers: { 'Retry-After': retryAfter } },
      [`/api/sm-relay/boxes/${boxId}/envelopes?limit=1`]: { status: 507, body: '{"error":"box_full"}', headers: {} },
    };
    /** @type {typeof fetch} */
    const fetchImpl = async (url, init) => {
      const u = new URL(String(url));
      const hit = replay[u.pathname + u.search];
      expect(/** @type {any} */ (init).headers.Authorization).toBe(`Bearer ${TOKEN}`);
      return new Response(hit.body, { status: hit.status, headers: { 'Content-Type': 'application/json', ...hit.headers } });
    };
    const rc = createRelayClient({ baseUrl: 'https://bilko.run', getDeviceToken: () => TOKEN, fetchImpl });
    expect(await rc.listBoxes()).toEqual({ ok: false, status: 410, error: 'box_paused' });
    const rl = await rc.patchBox(boxId, { label: 'z' });
    expect(rl).toEqual({ ok: false, status: 429, error: 'rate_limited', retryAfterSec: Number(retryAfter) });
    expect(await rc.listEnvelopes(boxId, 1)).toEqual({ ok: false, status: 507, error: 'box_full' });
  });

  it('no token -> not_linked on every method, with no request', async () => {
    for (const get of [() => null, () => '', async () => undefined, () => { throw new Error(TOKEN); }]) {
      const before = mock.state.requests.length;
      const c = createRelayClient({ baseUrl: proxy.baseUrl, getDeviceToken: /** @type {any} */ (get) });
      const results = [
        await c.createBox({ label: 'x', publicKey: 'p', allowedOrigins: [ORIGIN] }),
        await c.listBoxes(),
        await c.patchBox('B', {}),
        await c.deleteBox('B'),
        await c.listEnvelopes('B', 1),
        await c.getEnvelope('B', 'e'),
        await c.ackEnvelope('B', 'e'),
      ];
      for (const r of results) expect(r).toEqual({ ok: false, status: 0, error: 'not_linked' });
      expect(mock.state.requests.length).toBe(before);
      expectNoToken(results);
    }
  });

  it('network failure and timeout never throw and never leak the token', async () => {
    const dead = createRelayClient({ baseUrl: 'http://127.0.0.1:1', getDeviceToken: () => TOKEN });
    const r = await dead.listBoxes();
    expect(r).toEqual({ ok: false, status: 0, error: 'network_error' });
    expectNoToken(r);

    const hang = http.createServer(() => {});
    await new Promise((res) => hang.listen(0, '127.0.0.1', () => res(undefined)));
    const port = /** @type {import('node:net').AddressInfo} */ (hang.address()).port;
    const slow = createRelayClient({ baseUrl: `http://127.0.0.1:${port}`, getDeviceToken: () => TOKEN, timeoutMs: 100 });
    const t = await slow.getEnvelope('B', 'e');
    expect(t).toEqual({ ok: false, status: 0, error: 'timeout' });
    hang.closeAllConnections?.();
    await new Promise((res) => hang.close(() => res(undefined)));
  });

  it('defaults to https://bilko.run/api/sm-relay with a 15 s timeout signal', async () => {
    /** @type {string[]} */ const urls = [];
    /** @type {typeof fetch} */
    const fetchImpl = async (url, init) => {
      urls.push(String(url));
      expect(init && init.signal).toBeInstanceOf(AbortSignal);
      return new Response('{"boxes":[]}', { status: 200 });
    };
    const c = createRelayClient({ getDeviceToken: () => TOKEN, fetchImpl });
    expect(await c.listBoxes()).toEqual({ ok: true, boxes: [] });
    expect(urls).toEqual(['https://bilko.run/api/sm-relay/boxes']);
  });
});

/**
 * relayBoxesMock.cjs — test-only HTTP server implementing the bilko.run relay's sealed
 * drop-box contract ("Host contract v1" in
 * session-manager-operations/architecture/site-feedback.md). It is the executable spec of
 * what Bilko is asked to build: the desktop relay client, the drain and the widget transport
 * all test against it. Node built-ins only; not a test file (no `.test.cjs` suffix).
 *
 * Mirrors Bilko's confirmed host contract (Bilko PRDs 1928-1938, 2026-11-23).
 *
 * Test knobs beyond the contract:
 *   - `X-Test-Email` header: the caller's account email, checked against `allowEmails`
 *     (owner gate) on POST /boxes -> 403 not_enabled.
 *   - `X-Test-Ip` header: overrides the client IP used by the per-IP rate limit.
 *   - `state.boxes` / `state.envelopes` are live maps a test may seed directly (e.g. a box
 *     with `accountId: 'other'` answers 403 not_allowed to this account).
 *   - `now` option: injectable clock (ms) for rate-limit windows and timestamps.
 */
'use strict';

const http = require('node:http');
const crypto = require('node:crypto');

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const MAX_BODY = 12 * 1024 * 1024;
const MAX_BOX_ENVELOPES = 500;
const MAX_BOX_BYTES = 200 * 1024 * 1024;
const IP_LIMIT = 10;
const IP_WINDOW_MS = 60 * 1000;
const BOX_LIMIT = 60;
const BOX_WINDOW_MS = 60 * 60 * 1000;
const ALLOW_HEADERS = 'Content-Type, X-Sm-Envelope, X-Sm-Report-Id';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACCOUNT_ID = 'acct-test';

/** @param {number} n */
function crockford(n) {
  const bytes = crypto.randomBytes(n);
  let s = '';
  for (let i = 0; i < n; i++) s += CROCKFORD[bytes[i] & 31];
  return s;
}

/** @param {unknown} label */
function validLabel(label) {
  return typeof label === 'string' && label.length >= 1 && label.length <= 80;
}

/** @param {unknown} pk */
function validPublicKey(pk) {
  if (typeof pk !== 'string' || !/^[A-Za-z0-9_-]+$/.test(pk)) return false;
  const raw = Buffer.from(pk, 'base64url');
  if (raw.length !== 65 || raw[0] !== 0x04 || raw.toString('base64url') !== pk) return false;
  try {
    crypto.createPublicKey({
      key: {
        kty: 'EC',
        crv: 'P-256',
        x: raw.subarray(1, 33).toString('base64url'),
        y: raw.subarray(33, 65).toString('base64url'),
      },
      format: 'jwk',
    });
    return true;
  } catch {
    return false;
  }
}

/** @param {unknown} origins */
function validOrigins(origins) {
  if (!Array.isArray(origins) || origins.length < 1 || origins.length > 10) return false;
  const seen = new Set();
  for (const o of origins) {
    if (typeof o !== 'string') return false;
    let url;
    try {
      url = new URL(o);
    } catch {
      return false;
    }
    if (url.origin !== o) return false;
    const ok =
      url.protocol === 'https:' ||
      (url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1'));
    if (!ok) return false;
    if (seen.has(o)) return false;
    seen.add(o);
  }
  return true;
}

/**
 * @param {{ deviceToken: string, clerkToken?: string, allowEmails?: string[],
 *   maxBoxesPerAccount?: number, deviceId?: string, now?: () => number }} opts
 */
async function startRelayBoxesMock(opts) {
  const {
    deviceToken,
    clerkToken,
    allowEmails,
    maxBoxesPerAccount = 25,
    deviceId = 'dev-test-0001',
    now = () => Date.now(),
  } = opts;
  if (!deviceToken) throw new Error('startRelayBoxesMock: deviceToken required');

  const state = {
    /** @type {Map<string, any>} boxId -> box */
    boxes: new Map(),
    /** @type {Map<string, any[]>} boxId -> envelopes, oldest first */
    envelopes: new Map(),
    /** @type {Map<string, Map<string, string>>} boxId -> clientReportId -> hostId */
    reportIds: new Map(),
    /** @type {Map<string, number[]>} */
    ipHits: new Map(),
    /** @type {Map<string, number[]>} */
    boxHits: new Map(),
    /** @type {{ method: string, path: string, headers: object }[]} */
    requests: [],
    deviceId,
    accountId: ACCOUNT_ID,
  };

  const iso = () => new Date(now()).toISOString();

  /** @param {any} box */
  function boxView(box) {
    const envs = state.envelopes.get(box.boxId) || [];
    return {
      boxId: box.boxId,
      label: box.label,
      allowedOrigins: [...box.allowedOrigins],
      publicKey: box.publicKey,
      state: box.state,
      pending: envs.length,
      pendingBytes: envs.reduce((n, e) => n + e.bytes, 0),
      createdAt: box.createdAt,
      lastReceivedAt: box.lastReceivedAt,
      deviceId: box.deviceId,
    };
  }

  /**
   * @param {http.ServerResponse} res
   * @param {number} status
   * @param {unknown} body
   * @param {Record<string, string>} [headers]
   */
  function send(res, status, body, headers = {}) {
    const text = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text), ...headers });
    res.end(text);
  }

  /** @param {http.IncomingMessage} req @returns {Promise<{ buf: Buffer, tooLarge: boolean }>} */
  function readBody(req) {
    return new Promise((resolve, reject) => {
      /** @type {Buffer[]} */
      const chunks = [];
      let size = 0;
      let tooLarge = false;
      req.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY) {
          tooLarge = true;
          chunks.length = 0;
        } else if (!tooLarge) chunks.push(c);
      });
      req.on('end', () => resolve({ buf: tooLarge ? Buffer.alloc(0) : Buffer.concat(chunks), tooLarge }));
      req.on('error', reject);
    });
  }

  /** @param {http.IncomingMessage} req */
  async function readJson(req) {
    const { buf, tooLarge } = await readBody(req);
    if (tooLarge) return { error: 'payload_too_large', status: 413 };
    if (buf.length === 0) return { value: {} };
    try {
      const value = JSON.parse(buf.toString('utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value)) return { error: 'invalid_json', status: 400 };
      return { value };
    } catch {
      return { error: 'invalid_json', status: 400 };
    }
  }

  /** @param {http.IncomingMessage} req @returns {{ kind: 'device'|'clerk' } | { status: number, error: string }} */
  function auth(req) {
    const h = req.headers.authorization;
    if (!h) return { status: 401, error: 'missing_token' };
    const m = /^Bearer\s+(.+)$/i.exec(h);
    if (!m) return { status: 401, error: 'invalid_token' };
    const tok = m[1].trim();
    if (tok === deviceToken) return { kind: 'device' };
    if (clerkToken && tok === clerkToken) return { kind: 'clerk' };
    return { status: 401, error: 'invalid_token' };
  }

  /** Box lookup for owner routes: 404 when missing, 403 not_allowed when another account's. */
  function ownedBox(/** @type {string} */ boxId) {
    const box = state.boxes.get(boxId);
    if (!box) return { status: 404, error: 'box_not_found' };
    if (box.accountId !== ACCOUNT_ID) return { status: 403, error: 'not_allowed' };
    return { box };
  }

  /** @param {Map<string, number[]>} map @param {string} key @param {number} limit @param {number} windowMs */
  function windowCheck(map, key, limit, windowMs) {
    const t = now();
    const hits = (map.get(key) || []).filter((x) => x > t - windowMs);
    map.set(key, hits);
    if (hits.length >= limit) return Math.max(1, Math.ceil((hits[0] + windowMs - t) / 1000));
    return 0;
  }

  /** @param {http.IncomingMessage} req @param {http.ServerResponse} res */
  async function handleOwner(req, res, /** @type {string[]} */ parts, /** @type {URL} */ url) {
    const a = auth(req);
    if ('error' in a) return send(res, a.status, { error: a.error });
    const method = req.method;

    // /boxes
    if (parts.length === 1) {
      if (method === 'POST') {
        if (a.kind !== 'device') return send(res, 403, { error: 'device_token_required' });
        if (allowEmails) {
          const email = String(req.headers['x-test-email'] || '').toLowerCase();
          if (!allowEmails.map((e) => e.toLowerCase()).includes(email)) return send(res, 403, { error: 'not_enabled' });
        }
        const j = await readJson(req);
        if (j.error) return send(res, j.status, { error: j.error });
        const { label, publicKey, allowedOrigins } = j.value;
        if (!validLabel(label)) return send(res, 400, { error: 'invalid_label' });
        if (!validPublicKey(publicKey)) return send(res, 400, { error: 'invalid_public_key' });
        if (!validOrigins(allowedOrigins)) return send(res, 400, { error: 'invalid_allowed_origins' });
        const owned = [...state.boxes.values()].filter((b) => b.accountId === ACCOUNT_ID).length;
        if (owned >= maxBoxesPerAccount) return send(res, 403, { error: 'box_limit_reached' });
        let boxId;
        do boxId = crockford(8);
        while (state.boxes.has(boxId));
        const box = {
          boxId,
          label,
          allowedOrigins: [...allowedOrigins],
          publicKey,
          state: 'open',
          createdAt: iso(),
          lastReceivedAt: null,
          deviceId,
          accountId: ACCOUNT_ID,
        };
        state.boxes.set(boxId, box);
        state.envelopes.set(boxId, []);
        return send(res, 201, { boxId, state: 'open', createdAt: box.createdAt });
      }
      if (method === 'GET') {
        const boxes = [...state.boxes.values()].filter((b) => b.accountId === ACCOUNT_ID).map(boxView);
        return send(res, 200, { boxes });
      }
      return send(res, 405, { error: 'method_not_allowed' });
    }

    const boxId = parts[1];

    // /boxes/:boxId
    if (parts.length === 2) {
      if (method !== 'PATCH' && method !== 'DELETE') return send(res, 405, { error: 'method_not_allowed' });
      const o = ownedBox(boxId);
      if (!o.box) return send(res, o.status, { error: o.error });
      if (method === 'DELETE') {
        state.boxes.delete(boxId);
        state.envelopes.delete(boxId);
        state.reportIds.delete(boxId);
        state.boxHits.delete(boxId);
        return send(res, 200, { ok: true });
      }
      const j = await readJson(req);
      if (j.error) return send(res, j.status, { error: j.error });
      const patch = j.value;
      if ('label' in patch && !validLabel(patch.label)) return send(res, 400, { error: 'invalid_label' });
      if ('allowedOrigins' in patch && !validOrigins(patch.allowedOrigins))
        return send(res, 400, { error: 'invalid_allowed_origins' });
      if ('state' in patch && patch.state !== 'open' && patch.state !== 'paused')
        return send(res, 400, { error: 'invalid_state' });
      if ('label' in patch) o.box.label = patch.label;
      if ('allowedOrigins' in patch) o.box.allowedOrigins = [...patch.allowedOrigins];
      if ('state' in patch) o.box.state = patch.state;
      return send(res, 200, boxView(o.box));
    }

    // drain routes: device token only
    if (a.kind !== 'device') return send(res, 403, { error: 'device_token_required' });
    const o = ownedBox(boxId);
    if (!o.box) return send(res, o.status, { error: o.error });
    const envs = state.envelopes.get(boxId) || [];

    if (parts.length === 3) {
      if (method !== 'GET') return send(res, 405, { error: 'method_not_allowed' });
      const raw = url.searchParams.get('limit');
      let limit = 20;
      if (raw !== null) {
        if (!/^\d+$/.test(raw)) return send(res, 400, { error: 'invalid_limit' });
        limit = Number(raw);
        if (limit < 1 || limit > 20) return send(res, 400, { error: 'invalid_limit' });
      }
      const envelopes = envs.slice(0, limit).map((e) => ({
        envelopeId: e.envelopeId,
        hostId: e.hostId,
        clientReportId: e.clientReportId,
        receivedAt: e.receivedAt,
        origin: e.origin,
        bytes: e.bytes,
      }));
      return send(res, 200, { envelopes });
    }

    const envelopeId = parts[3];
    const idx = envs.findIndex((e) => e.envelopeId === envelopeId);
    if (method !== 'GET' && method !== 'DELETE') return send(res, 405, { error: 'method_not_allowed' });
    if (idx < 0) return send(res, 404, { error: 'envelope_not_found' });
    if (method === 'GET') {
      const body = envs[idx].body;
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Cache-Control': 'no-store',
        'Content-Length': body.length,
      });
      return res.end(body);
    }
    envs.splice(idx, 1);
    return send(res, 200, { ok: true });
  }

  /** @param {http.IncomingMessage} req @param {http.ServerResponse} res */
  async function handlePublicKey(req, res, /** @type {string} */ boxId) {
    if (req.method !== 'GET') return send(res, 405, { error: 'method_not_allowed' });
    const box = state.boxes.get(boxId);
    const cors = { 'Access-Control-Allow-Origin': '*' };
    if (!box) return send(res, 404, { error: 'box_not_found' }, cors);
    return send(
      res,
      200,
      { boxId, publicKey: box.publicKey, state: box.state },
      { ...cors, 'Cache-Control': 'public, max-age=60' },
    );
  }

  /** @param {http.IncomingMessage} req @param {http.ServerResponse} res */
  async function handleSubmit(req, res, /** @type {string} */ boxId) {
    const box = state.boxes.get(boxId);
    if (!box) {
      await readBody(req);
      return send(res, 404, { error: 'box_not_found' });
    }
    const origin = req.headers.origin;
    if (typeof origin !== 'string' || !box.allowedOrigins.includes(origin)) {
      await readBody(req);
      return send(res, 403, { error: 'origin_not_allowed' });
    }
    const cors = { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' };

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        ...cors,
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': ALLOW_HEADERS,
        'Access-Control-Max-Age': '600',
      });
      return res.end();
    }

    const { buf, tooLarge } = await readBody(req);

    const ip = String(req.headers['x-test-ip'] || req.socket.remoteAddress || 'unknown');
    const ipWait = windowCheck(state.ipHits, ip, IP_LIMIT, IP_WINDOW_MS);
    const boxWait = windowCheck(state.boxHits, boxId, BOX_LIMIT, BOX_WINDOW_MS);
    if (ipWait || boxWait)
      return send(res, 429, { error: 'rate_limited' }, { ...cors, 'Retry-After': String(Math.max(ipWait, boxWait)) });
    const t = now();
    state.ipHits.get(ip)?.push(t);
    state.boxHits.get(boxId)?.push(t);

    if (box.state === 'paused') return send(res, 410, { error: 'box_paused' }, cors);
    if (req.headers['x-sm-envelope'] !== '1') return send(res, 400, { error: 'bad_envelope' }, cors);
    const reportId = req.headers['x-sm-report-id'];
    if (typeof reportId !== 'string' || !UUID_RE.test(reportId))
      return send(res, 400, { error: 'invalid_report_id' }, cors);
    if (tooLarge) return send(res, 413, { error: 'payload_too_large' }, cors);
    if (buf.length < 4 || buf.subarray(0, 4).toString('latin1') !== 'SMF1')
      return send(res, 400, { error: 'bad_envelope' }, cors);

    let seen = state.reportIds.get(boxId);
    if (!seen) state.reportIds.set(boxId, (seen = new Map()));
    const key = reportId.toLowerCase();
    const prior = seen.get(key);
    if (prior) return send(res, 200, { id: prior }, cors);

    let envs = state.envelopes.get(boxId);
    if (!envs) state.envelopes.set(boxId, (envs = []));
    const pendingBytes = envs.reduce((n, e) => n + e.bytes, 0);
    if (envs.length >= MAX_BOX_ENVELOPES || pendingBytes + buf.length > MAX_BOX_BYTES)
      return send(res, 507, { error: 'box_full' }, cors);

    const used = new Set(seen.values());
    let hostId;
    do hostId = 'FB-' + crockford(5);
    while (used.has(hostId));
    const receivedAt = iso();
    envs.push({
      envelopeId: crypto.randomUUID(),
      hostId,
      clientReportId: reportId,
      receivedAt,
      origin,
      bytes: buf.length,
      body: buf,
    });
    seen.set(key, hostId);
    box.lastReceivedAt = receivedAt;
    return send(res, 201, { id: hostId }, cors);
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      state.requests.push({ method: req.method || '', path: url.pathname + url.search, headers: { ...req.headers } });
      const parts = url.pathname.split('/').filter(Boolean);
      if (parts[0] !== 'boxes' || parts.length > 4) {
        await readBody(req);
        return send(res, 404, { error: 'not_found' });
      }
      if (parts.length === 3 && parts[2] === 'key') return await handlePublicKey(req, res, parts[1]);
      if (parts.length === 3 && parts[2] === 'envelopes' && (req.method === 'POST' || req.method === 'OPTIONS'))
        return await handleSubmit(req, res, parts[1]);
      if (parts.length >= 3 && parts[2] !== 'envelopes') {
        await readBody(req);
        return send(res, 404, { error: 'not_found' });
      }
      return await handleOwner(req, res, parts, url);
    } catch (e) {
      if (!res.headersSent) send(res, 500, { error: 'internal', message: String(e && /** @type {Error} */ (e).message) });
      else res.destroy();
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(undefined));
  });
  const addr = /** @type {import('node:net').AddressInfo} */ (server.address());
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  function stop() {
    return new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve(undefined));
    });
  }

  return { baseUrl, stop, state };
}

module.exports = { startRelayBoxesMock, validPublicKey, validOrigins };

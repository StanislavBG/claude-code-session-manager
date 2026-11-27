/**
 * localAdminHttp.cjs — generic loopback-only HTTP transport with bearer-token
 * auth, extracted from the former standalone admin HTTP server module
 * (PRD 689). This module owns
 * ONLY the transport: token bootstrap/persistence, timing-safe comparison,
 * body reading, JSON responses, and a route-registration/dispatch mechanism.
 * Route *logic* (job-management, PRD creation) lives beside the module that
 * already owns that capability — see scheduler.cjs's registerAdminRoutes and
 * prdCreate.cjs's registerAdminRoute.
 *
 * Security posture (unchanged from the former module):
 *   - Binds 127.0.0.1 only, OS-assigned ephemeral port. Never reachable
 *     off-box.
 *   - Bearer token, regenerated every app boot, written to
 *     ~/.claude/session-manager/admin-api.json with 0600 perms.
 *   - Token compared with crypto.timingSafeEqual to avoid a timing
 *     side-channel on the comparison itself.
 *
 * Mode-scoped token file (confirmed-live incident 2026-07-29): a dev-mode or
 * e2e Electron launch (SM_DEV=1 / SM_E2E=1) intentionally skips the
 * single-instance lock (index.cjs), so it can run concurrently with a
 * production instance. Without a mode-specific path, that dev/e2e instance's
 * boot silently overwrote the production instance's admin-api.json with its
 * own (soon-to-be-dead) port+token, orphaning scheduler-mcp-server.cjs's
 * access to the still-running production app with no error anywhere. Dev/e2e
 * instances now write to admin-api.dev.json / admin-api.e2e.json instead —
 * see resolveTokenPath(). Production (neither env var set) is unaffected:
 * it still writes/reads admin-api.json, matching scheduler-mcp-server.cjs's
 * hardcoded read path.
 */

'use strict';

const http = require('node:http');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { EventEmitter } = require('node:events');
const fsp = require('node:fs/promises');
const config = require('../../config.cjs');
const schedulerPaths = require('../scheduler/schedulerPaths.cjs');
// App + outside-contract version, reported on the health route, unknown-route
// 404s and in the token file so outside callers never probe for a route.
const { contractInfo, healthInfo } = require('../externalContract.cjs');

/**
 * Mode-aware token file path, resolved fresh on every call (never cached at
 * module load) so a dev/e2e launch never collides with a production
 * instance's admin-api.json. The SM_ADMIN_TOKEN_PATH / SM_DEV / SM_E2E ladder
 * lives in schedulerPaths.adminTokenPath() (the SM_ADMIN_TOKEN_PATH override
 * exists because unit tests once overwrote the live app's port+token).
 */
const resolveTokenPath = schedulerPaths.adminTokenPath;

// Reserved health-check path, handled directly (not via registerRoute) so
// start()'s post-boot self-check never depends on route-registration order
// relative to start() across callers (chatRunner/scheduler/prdCreate).
const HEALTH_PATH = '/__admin/health';

function timingSafeEqualStrings(a, b) {
  const bufA = Buffer.from(String(a ?? ''));
  const bufB = Buffer.from(String(b ?? ''));
  if (bufA.length !== bufB.length) {
    // Compare against a same-length buffer anyway so the failure path still
    // takes constant time relative to the (fixed) token length, rather than
    // returning early on a length mismatch.
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

function readBody(req, maxBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

/**
 * Create the admin HTTP transport. Route handlers are registered via
 * `registerRoute(method, url, handler)`, where `handler` is
 * `async (req, res, rawBody) => void` — raw body reading is the transport's
 * job (routes call `JSON.parse` themselves as needed, matching the original
 * per-route body handling in the former module).
 */
function createAdminHttp() {
  let server = null;
  let token = null;
  const routes = new Map();

  async function ensureToken() {
    token = crypto.randomBytes(32).toString('hex');
    const tokenPath = resolveTokenPath();
    await config.writeJson(tokenPath, { port: null, token, ...contractInfo() });
    try { await fsp.chmod(tokenPath, 0o600); } catch { /* best-effort on platforms without POSIX perms */ }
    return token;
  }

  async function persistPort(port) {
    const tokenPath = resolveTokenPath();
    await config.writeJson(tokenPath, { port, token, ...contractInfo() });
    try { await fsp.chmod(tokenPath, 0o600); } catch { /* */ }
  }

  function authorized(req) {
    const header = req.headers.authorization || '';
    const match = /^Bearer (.+)$/.exec(header);
    if (!match) return false;
    return timingSafeEqualStrings(match[1], token);
  }

  function registerRoute(method, url, handler) {
    routes.set(`${method} ${url}`, handler);
  }

  async function handleRequest(req, res) {
    if (!authorized(req)) {
      sendJson(res, 401, { ok: false, error: 'unauthorized' });
      return;
    }
    await dispatch(req, res);
  }

  /**
   * Route dispatch shared by the HTTP server (after auth) and invoke() (no
   * auth — in-process callers are already inside the main process).
   */
  async function dispatch(req, res) {
    // Route lookup is keyed by pathname only — req.url carries the raw query
    // string too, which would otherwise never match a registered route (every
    // route before PRD 1024 was query-free, so this was a latent gap, not a
    // behavior change for them). `query` is handed to the route handler as a
    // third argument (URLSearchParams) for routes that need it (e.g. GET
    // /admin/scheduler/prds?cwd=&epicId=&status=).
    const urlObj = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'GET' && urlObj.pathname === HEALTH_PATH) {
      sendJson(res, 200, { ok: true, ...healthInfo() });
      return;
    }
    try {
      const handler = routes.get(`${req.method} ${urlObj.pathname}`);
      if (!handler) {
        // Keep error 'not found' so older MCP servers still see the same key;
        // unknownRoute marks this as transport-level (version skew), not a
        // route handler's own 'not found'. appVersion is always present
        // (null when unreadable) so outside callers see one shape.
        const { appVersion, contractVersion } = contractInfo();
        sendJson(res, 404, {
          ok: false,
          error: 'not found',
          unknownRoute: `${req.method} ${urlObj.pathname}`,
          appVersion: appVersion ?? null,
          contractVersion,
        });
        return;
      }
      await handler(req, res, urlObj.searchParams);
    } catch (e) {
      sendJson(res, 500, { ok: false, error: e?.message ?? 'internal error' });
    }
  }

  /**
   * Post-boot self-check: confirm the server actually answers on the port
   * it just wrote to the token file, before start() reports success. Catches
   * the class of bug where the written port/token is stale or the listener
   * never came up right — otherwise the only symptom is a caller getting
   * "unauthorized"/connection-refused with zero context in the logs.
   */
  function selfCheck(port) {
    return new Promise((resolve, reject) => {
      const req = http.request(
        { hostname: '127.0.0.1', port, method: 'GET', path: HEALTH_PATH, headers: { Authorization: `Bearer ${token}` }, timeout: 2000 },
        (res) => {
          res.resume();
          res.on('end', () => {
            if (res.statusCode === 200) resolve();
            else reject(new Error(`admin HTTP self-check got status ${res.statusCode} from port ${port}`));
          });
        },
      );
      req.on('timeout', () => { req.destroy(new Error(`admin HTTP self-check timed out on port ${port}`)); });
      req.on('error', (e) => reject(new Error(`admin HTTP self-check failed to reach port ${port}: ${e.message}`)));
      req.end();
    });
  }

  async function start() {
    await ensureToken();
    server = http.createServer((req, res) => {
      handleRequest(req, res).catch(() => {
        try { sendJson(res, 500, { ok: false, error: 'internal error' }); } catch { /* */ }
      });
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const { port } = server.address();
    try {
      await persistPort(port);
      await selfCheck(port);
    } catch (e) {
      await stop();
      throw e;
    }
    return { port, token };
  }

  async function stop() {
    if (!server) return;
    await new Promise((resolve) => server.close(() => resolve()));
    server = null;
  }

  /**
   * In-process call into a registered route — same handler, validation,
   * idempotency and audit rows as the HTTP API, with no socket and no bearer
   * token. `query` may be a plain object or URLSearchParams; it is merged
   * onto any query already in `routePath`. `body` (any JSON value) is
   * serialized and streamed to the handler like an HTTP request body.
   * Resolves { status, json } (json null when the handler wrote non-JSON).
   */
  async function invoke(method, routePath, { body, query, trustedService } = {}) {
    const urlObj = new URL(routePath, 'http://127.0.0.1');
    if (query) {
      const params = query instanceof URLSearchParams ? query : new URLSearchParams(
        Object.entries(query).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => [k, String(v)]),
      );
      for (const [k, v] of params) urlObj.searchParams.append(k, v);
    }
    const payload = body === undefined ? '' : JSON.stringify(body);
    const req = createInMemoryRequest(String(method).toUpperCase(), `${urlObj.pathname}${urlObj.search}`, payload);
    // Trusted-channel service identity: a Symbol key no HTTP request can carry.
    if (trustedService && typeof trustedService.serviceId === 'string') {
      req[Symbol.for('sm.trustedService')] = { serviceId: trustedService.serviceId };
    }
    const res = createResponseShim();
    try {
      await dispatch(req, res);
    } catch (e) {
      if (!res.writableEnded) sendJson(res, 500, { ok: false, error: e?.message ?? 'internal error' });
    }
    return res.result();
  }

  return {
    start,
    stop,
    registerRoute,
    invoke,
    get token() { return token; },
    get server() { return server; },
  };
}

/** In-memory IncomingMessage stand-in: a Readable carrying the JSON body. */
function createInMemoryRequest(method, url, payload) {
  const buf = Buffer.from(payload, 'utf8');
  const req = new Readable({ read() {} });
  if (buf.length) req.push(buf);
  req.push(null);
  req.method = method;
  req.url = url;
  req.headers = buf.length
    ? { 'content-type': 'application/json', 'content-length': String(buf.length) }
    : {};
  req.socket = null;
  req.setTimeout = () => req;
  return req;
}

/** ServerResponse stand-in capturing status, headers and the written body. */
function createResponseShim() {
  const res = new EventEmitter();
  const chunks = [];
  const headers = {};
  res.statusCode = 200;
  res.headersSent = false;
  res.writableEnded = false;
  res.finished = false;
  res.destroyed = false;
  res.writableLength = 0;
  res.setHeader = (name, value) => { headers[String(name).toLowerCase()] = value; return res; };
  res.getHeader = (name) => headers[String(name).toLowerCase()];
  res.removeHeader = (name) => { delete headers[String(name).toLowerCase()]; };
  res.writeHead = (status, a, b) => {
    res.statusCode = status;
    const hdrs = typeof a === 'object' && a !== null ? a : b;
    if (hdrs && typeof hdrs === 'object') for (const [k, v] of Object.entries(hdrs)) res.setHeader(k, v);
    res.headersSent = true;
    return res;
  };
  const toBuf = (chunk, enc) => (Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), typeof enc === 'string' ? enc : 'utf8'));
  res.write = (chunk, enc, cb) => {
    if (chunk !== undefined && chunk !== null) chunks.push(toBuf(chunk, enc));
    res.headersSent = true;
    const done = typeof enc === 'function' ? enc : cb;
    if (typeof done === 'function') done();
    return true;
  };
  res.end = (chunk, enc, cb) => {
    if (res.writableEnded) return res;
    if (typeof chunk === 'function') { cb = chunk; chunk = undefined; }
    if (chunk !== undefined && chunk !== null) chunks.push(toBuf(chunk, enc));
    res.headersSent = true;
    res.writableEnded = true;
    res.finished = true;
    const done = typeof enc === 'function' ? enc : cb;
    if (typeof done === 'function') done();
    res.emit('finish');
    res.emit('close');
    return res;
  };
  res.destroy = () => { res.destroyed = true; res.emit('close'); return res; };
  res.result = () => {
    const text = Buffer.concat(chunks).toString('utf8');
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { status: res.statusCode, json };
  };
  return res;
}

module.exports = {
  createAdminHttp,
  resolveTokenPath,
  timingSafeEqualStrings,
  readBody,
  sendJson,
};

// Lazy getter (the token path is mode-aware and env-driven; never frozen at require).
Object.defineProperty(module.exports, 'TOKEN_PATH', { get: () => schedulerPaths.adminTokenPath(), enumerable: true });

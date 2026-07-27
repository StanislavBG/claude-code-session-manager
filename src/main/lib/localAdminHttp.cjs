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
 */

'use strict';

const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const config = require('../config.cjs');

const TOKEN_PATH = path.join(os.homedir(), '.claude', 'session-manager', 'admin-api.json');

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
    await config.writeJson(TOKEN_PATH, { port: null, token });
    try { await fsp.chmod(TOKEN_PATH, 0o600); } catch { /* best-effort on platforms without POSIX perms */ }
    return token;
  }

  async function persistPort(port) {
    await config.writeJson(TOKEN_PATH, { port, token });
    try { await fsp.chmod(TOKEN_PATH, 0o600); } catch { /* */ }
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
    try {
      const handler = routes.get(`${req.method} ${req.url}`);
      if (!handler) {
        sendJson(res, 404, { ok: false, error: 'not found' });
        return;
      }
      await handler(req, res);
    } catch (e) {
      sendJson(res, 500, { ok: false, error: e?.message ?? 'internal error' });
    }
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
    await persistPort(port);
    return { port, token };
  }

  async function stop() {
    if (!server) return;
    await new Promise((resolve) => server.close(() => resolve()));
    server = null;
  }

  return {
    start,
    stop,
    registerRoute,
    get token() { return token; },
    get server() { return server; },
  };
}

module.exports = {
  createAdminHttp,
  TOKEN_PATH,
  timingSafeEqualStrings,
  readBody,
  sendJson,
};

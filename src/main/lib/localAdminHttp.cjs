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
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const config = require('../config.cjs');

const TOKEN_PATH = path.join(os.homedir(), '.claude', 'session-manager', 'admin-api.json');

/**
 * Mode-aware token file path, resolved fresh on every call (not cached at
 * module load) so a dev/e2e launch never collides with a production
 * instance's admin-api.json. index.cjs treats SM_DEV and SM_E2E as one OR'd
 * `isDev` boolean with no ordering between them; if both happen to be set,
 * this resolves to the SM_DEV path (checked first below) — an arbitrary but
 * harmless tie-break, since real launches only ever set one or the other.
 */
function resolveTokenPath() {
  // Explicit override, highest priority. Exists because the unit tests call
  // createAdminHttp().start() directly with neither SM_DEV nor SM_E2E set,
  // which resolved to the PRODUCTION admin-api.json and overwrote the
  // running app's port+token with a throwaway test server's — silently
  // orphaning scheduler-mcp-server.cjs's access to the live app until the
  // next app restart (confirmed live 2026-08-01: `npm run test:unit` made
  // every scheduler_* MCP tool report "app is not running"). Tests point
  // this at a tmp file; production never sets it.
  if (process.env.SM_ADMIN_TOKEN_PATH) return process.env.SM_ADMIN_TOKEN_PATH;
  if (process.env.SM_DEV === '1') {
    return path.join(os.homedir(), '.claude', 'session-manager', 'admin-api.dev.json');
  }
  if (process.env.SM_E2E === '1') {
    return path.join(os.homedir(), '.claude', 'session-manager', 'admin-api.e2e.json');
  }
  return TOKEN_PATH;
}

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
    await config.writeJson(tokenPath, { port: null, token });
    try { await fsp.chmod(tokenPath, 0o600); } catch { /* best-effort on platforms without POSIX perms */ }
    return token;
  }

  async function persistPort(port) {
    const tokenPath = resolveTokenPath();
    await config.writeJson(tokenPath, { port, token });
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
    // Route lookup is keyed by pathname only — req.url carries the raw query
    // string too, which would otherwise never match a registered route (every
    // route before PRD 1024 was query-free, so this was a latent gap, not a
    // behavior change for them). `query` is handed to the route handler as a
    // third argument (URLSearchParams) for routes that need it (e.g. GET
    // /admin/scheduler/prds?cwd=&epicId=&status=).
    const urlObj = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'GET' && urlObj.pathname === HEALTH_PATH) {
      sendJson(res, 200, { ok: true });
      return;
    }
    try {
      const handler = routes.get(`${req.method} ${urlObj.pathname}`);
      if (!handler) {
        sendJson(res, 404, { ok: false, error: 'not found' });
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
  resolveTokenPath,
  timingSafeEqualStrings,
  readBody,
  sendJson,
};

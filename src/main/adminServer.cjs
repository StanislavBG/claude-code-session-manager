/**
 * adminServer.cjs — loopback-only HTTP admin API for the scheduler.
 *
 * Foundation for PRD 449 (an MCP server wraps this HTTP API). Exposes a
 * narrow, token-authed surface so a same-machine script/tool can reset a
 * stuck scheduler job or list jobs without hand-editing queue.json from
 * outside the running app (which would race the in-process mutate() queue
 * — see scheduler.cjs's serialized-mutation comment).
 *
 * Security posture:
 *   - Binds 127.0.0.1 only, OS-assigned ephemeral port. Never reachable
 *     off-box.
 *   - Bearer token, regenerated every app boot, written to
 *     ~/.claude/session-manager/admin-api.json with 0600 perms.
 *   - Token compared with crypto.timingSafeEqual to avoid a timing
 *     side-channel on the comparison itself.
 *   - Only two routes: reset-job (one narrow mutation) and jobs (read-only
 *     list). writePrd/pause/resume are intentionally NOT exposed here.
 */

'use strict';

const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const config = require('./config.cjs');

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
 * Create the admin HTTP server. `remote` is scheduler.cjs's remote object
 * (injected, not required directly, so this module stays testable without
 * booting Electron).
 */
function createAdminServer(remote) {
  let server = null;
  let token = null;

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

  async function handleRequest(req, res) {
    if (!authorized(req)) {
      sendJson(res, 401, { ok: false, error: 'unauthorized' });
      return;
    }
    try {
      if (req.method === 'GET' && req.url === '/admin/scheduler/jobs') {
        const jobs = await remote.listJobs();
        sendJson(res, 200, jobs);
        return;
      }
      if (req.method === 'POST' && req.url === '/admin/scheduler/reset-job') {
        const raw = await readBody(req);
        let parsed;
        try {
          parsed = raw ? JSON.parse(raw) : {};
        } catch {
          sendJson(res, 400, { ok: false, error: 'invalid JSON body' });
          return;
        }
        const slug = typeof parsed.slug === 'string' ? parsed.slug : null;
        if (!slug) {
          sendJson(res, 400, { ok: false, error: 'missing slug' });
          return;
        }
        const result = await remote.resetJob(slug);
        sendJson(res, 200, result);
        return;
      }
      sendJson(res, 404, { ok: false, error: 'not found' });
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

  return { start, stop, get token() { return token; }, get server() { return server; } };
}

module.exports = { createAdminServer, TOKEN_PATH };

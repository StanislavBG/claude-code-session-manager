/**
 * browserAgentServer.cjs — loopback-only HTTP API for driving the Browser
 * tab one ad-hoc action at a time (PRD 535 foundation).
 *
 * Deliberately a SEPARATE server from adminServer.cjs, not a route added to
 * it: adminServer.cjs documents itself as intentionally narrow ("Only two
 * routes... writePrd/pause/resume are intentionally NOT exposed here").
 * Arbitrary click/type/navigate/screenshot control of a live browser is a
 * materially larger capability surface than "reset one scheduler job" and
 * deserves its own security boundary, not creeping scope onto the existing
 * narrow one. A future MCP server (PRD 536) wraps this HTTP API the same way
 * scripts/scheduler-mcp-server.cjs wraps adminServer.cjs.
 *
 * Security posture (mirrors adminServer.cjs exactly):
 *   - Binds 127.0.0.1 only, OS-assigned ephemeral port. Never reachable
 *     off-box.
 *   - Bearer token, regenerated every app boot, written to
 *     ~/.claude/session-manager/browser-agent-api.json with 0600 perms.
 *     A distinct file from admin-api.json — this token is never shared with
 *     or derived from the scheduler's token.
 *   - Token compared with crypto.timingSafeEqual to avoid a timing
 *     side-channel on the comparison itself.
 *   - Four routes: list tabs (read-only), screenshot, single action
 *     (click/type/key/scroll/navigate), DOM/text snapshot.
 *
 * Out of scope for THIS server (see PRD 535's "Out of scope" section):
 * no confirmation/consent gating, no domain allowlist/blocklist, no
 * content-injection scanning. That safety layer is a deliberate, separate
 * follow-up decision, not an oversight.
 */

'use strict';

const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const config = require('./config.cjs');

const TOKEN_PATH = path.join(os.homedir(), '.claude', 'session-manager', 'browser-agent-api.json');
// Screenshots are base64 PNG data URLs — bigger cap than adminServer's 1MB,
// still bounded so a malformed/malicious body can't exhaust memory.
const BODY_MAX_BYTES = 8 * 1024 * 1024;

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

function readBody(req, maxBytes = BODY_MAX_BYTES) {
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

function safeParseJson(raw) {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/**
 * Create the browser-agent HTTP server. `remote` exposes the browserView.cjs
 * functions this server dispatches to (injected, not required directly, so
 * this module stays testable without booting Electron) — shape:
 *   { listTabs(): Promise<Array>, screenshot({viewId}): Promise<obj>,
 *     action(params): Promise<obj>, dom({viewId}): Promise<obj> }
 */
function createBrowserAgentServer(remote) {
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
      const url = new URL(req.url, 'http://127.0.0.1');

      if (req.method === 'GET' && url.pathname === '/agent/browser/tabs') {
        const tabs = await remote.listTabs();
        sendJson(res, 200, { ok: true, tabs });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/agent/browser/screenshot') {
        const raw = await readBody(req);
        const parsed = safeParseJson(raw);
        if (parsed === undefined) {
          sendJson(res, 400, { ok: false, error: 'invalid JSON body' });
          return;
        }
        const result = await remote.screenshot({ viewId: typeof parsed.viewId === 'string' ? parsed.viewId : undefined });
        sendJson(res, result.ok ? 200 : 400, result);
        return;
      }

      if (req.method === 'POST' && url.pathname === '/agent/browser/action') {
        const raw = await readBody(req);
        const parsed = safeParseJson(raw);
        if (parsed === undefined) {
          sendJson(res, 400, { ok: false, error: 'invalid JSON body' });
          return;
        }
        if (typeof parsed.action !== 'string' || !parsed.action) {
          sendJson(res, 400, { ok: false, error: 'missing action' });
          return;
        }
        const result = await remote.action(parsed);
        sendJson(res, result.ok ? 200 : 400, result);
        return;
      }

      if (req.method === 'GET' && url.pathname === '/agent/browser/dom') {
        const viewId = url.searchParams.get('viewId') || undefined;
        const result = await remote.dom({ viewId });
        sendJson(res, result.ok ? 200 : 400, result);
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

module.exports = { createBrowserAgentServer, TOKEN_PATH };

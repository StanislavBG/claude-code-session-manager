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
 *   - Three routes: reset-job (flips fields on an already-vetted job),
 *     jobs (read-only list), and create-prd (PRD 549 — authors a BRAND-NEW
 *     file that the scheduler will later run as `claude -p
 *     --dangerously-skip-permissions` in a caller-chosen, home-dir-bounded
 *     cwd; a materially larger blast radius than reset-job, justified only
 *     because it unblocks external automation with no other queueing path).
 *     cwd is validated via config.cjs's validatePath; title/cwd are
 *     newline-blocked at the zod boundary (ipcSchemas.cjs) to prevent
 *     frontmatter injection into the hand-rolled PRD serializer
 *     (prdCreate.cjs). pause/resume/cancel/update remain intentionally NOT
 *     exposed here.
 */

'use strict';

const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const config = require('./config.cjs');
const { expandHome } = require('./lib/expandHome.cjs');
const { schemas } = require('./ipcSchemas.cjs');
const prdCreate = require('./lib/prdCreate.cjs');

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
      if (req.method === 'POST' && req.url === '/admin/scheduler/create-prd') {
        const raw = await readBody(req);
        let parsed;
        try {
          parsed = raw ? JSON.parse(raw) : {};
        } catch {
          sendJson(res, 400, { ok: false, error: 'invalid JSON body' });
          return;
        }

        let input;
        try {
          input = schemas.schedulerCreatePrd.parse(parsed);
        } catch (e) {
          sendJson(res, 400, { ok: false, error: 'invalid PRD payload', details: e?.issues ?? e?.message });
          return;
        }

        // cwd is untrusted: this is the first *creating* mutation on a
        // token-authed API whose product is "a command that will later run
        // with --dangerously-skip-permissions in a chosen cwd". Route it
        // through config.cjs's validatePath (allowedRoots = home dir) —
        // same boundary every other fs-touching IPC handler uses — never a
        // bespoke check here.
        try {
          config.validatePath(expandHome(input.cwd));
        } catch (e) {
          sendJson(res, 400, { ok: false, error: `cwd rejected: ${e?.message ?? 'outside allowed roots'}` });
          return;
        }

        const slug = input.slug || prdCreate.deriveSlugFromTitle(input.title);
        if (!slug || !prdCreate.PRD_CREATE_SLUG_RE.test(slug)) {
          sendJson(res, 400, { ok: false, error: 'could not derive a valid kebab-case slug from title; supply "slug" explicitly' });
          return;
        }

        // NN allocation is delegated to allocateParallelGroup() (PRD 548) via
        // the injected remote — never re-derived here — unless the caller
        // opted into an existing group explicitly.
        const nn = input.parallelGroup ?? await remote.allocateParallelGroup();
        const filenameSlug = `${nn}-${slug}`;

        // An explicit `parallelGroup` bypasses allocateParallelGroup()'s
        // collision-proof reservation, so re-check for an existing file at
        // this exact destination before writing — remote.writePrd itself has
        // no existence guard (by design, it doubles as the edit-in-place
        // path for Scheduler UI PRD edits), so "create" must not silently
        // clobber an existing job's PRD.
        const existing = await remote.readPrd(filenameSlug);
        if (existing?.ok) {
          sendJson(res, 409, { ok: false, error: `PRD already exists: ${filenameSlug}.md` });
          return;
        }

        let standardsText;
        try {
          standardsText = await prdCreate.readStandards();
        } catch (e) {
          sendJson(res, 500, { ok: false, error: `could not read engineering standards: ${e?.message}` });
          return;
        }

        const body = prdCreate.buildPrdBody(input, standardsText);
        const writeResult = await remote.writePrd(filenameSlug, body);
        if (!writeResult?.ok) {
          sendJson(res, 500, { ok: false, error: writeResult?.error ?? 'write failed' });
          return;
        }

        sendJson(res, 200, { nn, filename: `${filenameSlug}.md`, status: 'queued' });
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

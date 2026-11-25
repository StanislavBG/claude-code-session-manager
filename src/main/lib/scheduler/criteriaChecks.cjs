'use strict';

/**
 * criteriaChecks.cjs — run each structured acceptance criterion's mechanical
 * check (prdCriteria.cjs shape) in a job's tree, so the outcome record and
 * the validator get observed results instead of the job's own prose.
 *
 *   - command: parsed with the gate's no-shell parser (parseChain) and run
 *     through the gate's own runner (runIsolatedSequence: own TMPDIR, CI=1,
 *     no shell). The whole chain is capped at COMMAND_CAP_MS.
 *   - file:    repo-relative path must exist (and contain `contains`, if set);
 *     a path that escapes `cwd` fails closed.
 *   - http:    loopback hosts only (re-checked here, never trusted from the
 *     frontmatter), no redirects followed, HTTP_TIMEOUT_MS timeout; ok when
 *     the response status equals the expected one (default 200) and, when
 *     `contains` is set, the first HTTP_BODY_MAX_BYTES of the body include it.
 *     With keepBody, each http row also carries { body, bodyBytes, truncated }
 *     (body capped at HTTP_BODY_MAX_BYTES); without it rows never hold a body.
 *   - httpRetry (opt-in, { attempts?, delayMs?, sleep? }): a dev server that is
 *     mid-reload refuses or 404s for a moment, so after the first in-order pass
 *     every http row that failed AFTER its request was sent (request/response
 *     error, timeout, status mismatch, contains miss) is re-run in order after
 *     ONE sleep(delayMs) per round, until none fail or `attempts` is reached
 *     (default HTTP_RETRY_ATTEMPTS = 3, clamped 1..3; delayMs default
 *     HTTP_RETRY_DELAY_MS). A re-run replaces the row in place (ok, detail and,
 *     with keepBody, the body fields). NEVER retried: spec refusals (invalid
 *     URL, non-http(s) protocol, non-loopback host, credentials in the URL) and
 *     file / command / manual rows. With httpRetry every http row carries
 *     `attempts` (1..3; a refusal is 1); without it no row has that key.
 *     Worst case per runCriteriaChecks call: each http check at most 3 attempts
 *     of at most HTTP_TIMEOUT_MS (15 s) each, plus at most 2 waits of delayMs
 *     shared by the whole call (not per check).
 *   - manual:  never run — ok: null; detail carries the guidance line.
 *
 * Never throws: every failure becomes { ok: false, detail }. Checks run
 * sequentially — one command at a time, like the gate.
 */

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const { parseChain, runIsolatedSequence } = require('./definitionOfDone.cjs');

const COMMAND_CAP_MS = 300_000;
const HTTP_TIMEOUT_MS = 15_000;
const HTTP_BODY_MAX_BYTES = 1024 * 1024;
const FILE_READ_MAX_BYTES = 16 * 1024 * 1024;
const DETAIL_MAX_CHARS = 500;
const HTTP_RETRY_ATTEMPTS = 3;
const HTTP_RETRY_DELAY_MS = 10_000;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** @param {string} s */
function clip(s) {
  const t = String(s ?? '').trim();
  return t.length > DETAIL_MAX_CHARS ? `…${t.slice(-DETAIL_MAX_CHARS)}` : t;
}

/**
 * @param {unknown} spec
 * @param {number} capMs
 * @param {string} cwd
 * @returns {Promise<{ok: boolean, detail: string}>}
 */
async function runCommandCheck(spec, capMs, cwd) {
  if (typeof spec !== 'string' || !spec.trim()) return { ok: false, detail: 'command check has no command' };
  const steps = parseChain(spec.trim());
  if (!steps.length) return { ok: false, detail: 'command cannot run without a shell (refused by the gate parser)' };
  const deadline = Date.now() + capMs;
  for (const step of steps) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { ok: false, detail: `timed out after ${capMs} ms cap` };
    const timeoutMs = Math.min(step.timeoutMs, remaining);
    const r = await runIsolatedSequence([{ ...step, timeoutMs }], { cwd });
    const res = r.results[0];
    if (r.status === 'green') continue;
    if (res && res.timedOut) return { ok: false, detail: `timed out after ${timeoutMs} ms: ${res.cmd}` };
    if (r.status === 'unavailable') return { ok: false, detail: `could not run: ${res ? res.cmd : step.argv.join(' ')}` };
    return { ok: false, detail: clip(`exit ${res ? res.code : '?'}: ${res ? res.cmd : ''}\n${res ? res.tail : ''}`) };
  }
  return { ok: true, detail: `exit 0 (${steps.length} step${steps.length === 1 ? '' : 's'})` };
}

/**
 * @param {unknown} spec
 * @param {string} cwd
 * @returns {{ok: boolean, detail: string}}
 */
function runFileCheck(spec, cwd) {
  /** @type {{path?: unknown, contains?: unknown}} */
  const obj = typeof spec === 'string' ? { path: spec } : (spec && typeof spec === 'object' ? /** @type {any} */ (spec) : {});
  const rel = obj.path;
  if (typeof rel !== 'string' || !rel.trim()) return { ok: false, detail: 'file check has no path' };
  const root = path.resolve(cwd);
  const abs = path.resolve(root, rel);
  if (path.isAbsolute(rel) || (abs !== root && !abs.startsWith(root + path.sep))) {
    return { ok: false, detail: `path is not repo-relative: ${rel}` };
  }
  let st;
  try { st = fs.statSync(abs); } catch { return { ok: false, detail: `missing: ${rel}` }; }
  if (obj.contains === undefined || obj.contains === null) return { ok: true, detail: `exists: ${rel}` };
  if (typeof obj.contains !== 'string') return { ok: false, detail: 'file check contains must be a string' };
  if (!st.isFile()) return { ok: false, detail: `not a file: ${rel}` };
  if (st.size > FILE_READ_MAX_BYTES) return { ok: false, detail: `too large to search (${st.size} bytes): ${rel}` };
  let text;
  try { text = fs.readFileSync(abs, 'utf8'); } catch (e) { return { ok: false, detail: `unreadable: ${rel}` }; }
  return text.includes(obj.contains)
    ? { ok: true, detail: `${rel} contains the text` }
    : { ok: false, detail: `${rel} does not contain ${JSON.stringify(obj.contains)}` };
}

/**
 * refused: internal marker for a spec refusal (never sent, never retried); never copied onto a row.
 * @typedef {{ok: boolean, detail: string, body?: string, bodyBytes?: number, truncated?: boolean, refused?: boolean}} HttpResult
 */

/**
 * @param {unknown} spec
 * @param {number} timeoutMs
 * @param {boolean} [keepBody] attach { body, bodyBytes, truncated } to the result
 * @returns {Promise<HttpResult>}
 */
function runHttpCheck(spec, timeoutMs, keepBody = false) {
  /** @type {{url?: unknown, status?: unknown, contains?: unknown}} */
  const obj = typeof spec === 'string' ? { url: spec } : (spec && typeof spec === 'object' ? /** @type {any} */ (spec) : {});
  let url;
  try { url = new URL(String(obj.url)); } catch { return Promise.resolve({ ok: false, detail: 'http check url is not a valid URL', refused: true }); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return Promise.resolve({ ok: false, detail: `refused: protocol ${url.protocol} (http/https only)`, refused: true });
  }
  if (!LOOPBACK_HOSTS.has(url.hostname) || url.username || url.password) {
    return Promise.resolve({ ok: false, detail: `refused: host "${url.hostname}" is not loopback`, refused: true });
  }
  const want = Number.isInteger(obj.status) ? /** @type {number} */ (obj.status) : 200;
  const contains = typeof obj.contains === 'string' && obj.contains !== '' ? obj.contains : null;
  const readBody = contains !== null || keepBody;
  const lib = url.protocol === 'https:' ? https : http;
  return new Promise((resolve) => {
    let done = false;
    /** @param {HttpResult} r */
    const finish = (r) => { if (!done) { done = true; clearTimeout(timer); resolve(r); } };
    /** @type {import('node:http').ClientRequest} */
    let req;
    const timer = setTimeout(() => {
      finish({ ok: false, detail: `timed out after ${timeoutMs} ms: ${url.href}` });
      try { req.destroy(); } catch { /* already gone */ }
    }, timeoutMs);
    try {
      // Self-signed certs are normal on a loopback dev server.
      req = lib.request(url, { method: 'GET', ...(lib === https ? { rejectUnauthorized: false } : {}) }, (res) => {
        const got = res.statusCode;
        if (!readBody) {
          res.resume();
          finish(got === want
            ? { ok: true, detail: `HTTP ${got}` }
            : { ok: false, detail: `HTTP ${got}, expected ${want}` });
          return;
        }
        /** @type {Buffer[]} */
        const chunks = [];
        let bytes = 0;
        let truncated = false;
        let settled = false;
        const decide = () => {
          if (settled) return;
          settled = true;
          const buf = Buffer.concat(chunks, bytes);
          const text = buf.toString('utf8');
          /** @type {HttpResult} */
          let r;
          if (got !== want) r = { ok: false, detail: `HTTP ${got}, expected ${want}` };
          else if (contains === null) r = { ok: true, detail: `HTTP ${got}` };
          else if (text.includes(contains)) r = { ok: true, detail: `HTTP ${got}, body contains the text` };
          else r = { ok: false, detail: clip(`HTTP ${got}, body does not contain ${JSON.stringify(contains)}`) };
          if (keepBody) Object.assign(r, { body: text, bodyBytes: bytes, truncated });
          finish(r);
        };
        res.on('data', (/** @type {Buffer} */ chunk) => {
          if (settled) return;
          const room = HTTP_BODY_MAX_BYTES - bytes;
          if (chunk.length > room) {
            if (room > 0) { chunks.push(chunk.subarray(0, room)); bytes += room; }
            truncated = true;
            decide();
            res.destroy();
            return;
          }
          chunks.push(chunk);
          bytes += chunk.length;
        });
        res.on('end', decide);
        res.on('error', (e) => finish({ ok: false, detail: `response failed: ${e && e.message ? e.message : e}` }));
      });
      req.on('error', (e) => finish({ ok: false, detail: `request failed: ${e && e.message ? e.message : e}` }));
      req.end();
    } catch (e) {
      finish({ ok: false, detail: `request failed: ${e && /** @type {Error} */ (e).message ? /** @type {Error} */ (e).message : e}` });
    }
  });
}

/**
 * @typedef {{id: string, kind: string, ok: boolean|null, detail: string, body?: string, bodyBytes?: number, truncated?: boolean, attempts?: number}} CheckRow
 * @typedef {{ attempts?: number, delayMs?: number, sleep?: (ms: number) => Promise<void> }} HttpRetry
 */

/**
 * @param {string} id
 * @param {string} kind
 * @param {{ok: boolean|null, detail: string, body?: string, bodyBytes?: number, truncated?: boolean}} r
 * @param {boolean} keepBody
 * @returns {CheckRow}
 */
function toRow(id, kind, r, keepBody) {
  /** @type {CheckRow} */
  const row = { id, kind, ok: r.ok, detail: r.detail };
  if (keepBody && kind === 'http' && typeof r.body === 'string') {
    row.body = r.body;
    row.bodyBytes = r.bodyBytes;
    row.truncated = r.truncated;
  }
  return row;
}

/** @param {unknown} e */
function errDetail(e) {
  return `check error: ${e && /** @type {Error} */ (e).message ? /** @type {Error} */ (e).message : e}`;
}

/**
 * @param {HttpRetry} httpRetry
 * @returns {{attempts: number, delayMs: number, sleep: (ms: number) => Promise<void>}}
 */
function normalizeRetry(httpRetry) {
  const a = httpRetry.attempts;
  const attempts = typeof a === 'number' && Number.isInteger(a)
    ? Math.min(HTTP_RETRY_ATTEMPTS, Math.max(1, a))
    : HTTP_RETRY_ATTEMPTS;
  const d = httpRetry.delayMs;
  const delayMs = typeof d === 'number' && Number.isFinite(d) && d >= 0 ? d : HTTP_RETRY_DELAY_MS;
  const sleep = typeof httpRetry.sleep === 'function'
    ? httpRetry.sleep
    : (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));
  return { attempts, delayMs, sleep: /** @type {(ms: number) => Promise<void>} */ (sleep) };
}

/**
 * Run every criterion's check in `cwd`, in order.
 *
 * @param {{ criteria: unknown, cwd: string, commandCapMs?: number, httpTimeoutMs?: number, keepBody?: boolean, httpRetry?: HttpRetry }} opts
 *   commandCapMs / httpTimeoutMs exist for tests; callers use the defaults.
 *   keepBody (default false): http rows also carry { body, bodyBytes, truncated };
 *   off, every row is exactly { id, kind, ok, detail } (gate shadow + job row store no body).
 *   httpRetry (default off): re-run failed-after-sent http checks (see header);
 *   http rows then also carry `attempts`.
 * @returns {Promise<CheckRow[]>}
 */
async function runCriteriaChecks({ criteria, cwd, commandCapMs = COMMAND_CAP_MS, httpTimeoutMs = HTTP_TIMEOUT_MS, keepBody = false, httpRetry }) {
  if (!Array.isArray(criteria) || !criteria.length) return [];
  const keep = keepBody === true;
  /** @type {CheckRow[]} */
  const out = [];
  /** @type {Array<{spec: unknown, retryable: boolean} | null>} per-index http state */
  const httpState = [];
  for (let i = 0; i < criteria.length; i++) {
    const c = criteria[i];
    const id = c && typeof c.id === 'string' ? c.id : `ac-${i + 1}`;
    const check = c && c.check && typeof c.check === 'object' ? c.check : { kind: 'manual' };
    const kind = typeof check.kind === 'string' ? check.kind : 'manual';
    /** @type {{ok: boolean|null, detail: string, body?: string, bodyBytes?: number, truncated?: boolean, refused?: boolean}} */
    let r;
    try {
      if (kind === 'manual') r = { ok: null, detail: typeof check.spec === 'string' && check.spec ? check.spec : 'manual check' };
      else if (kind === 'command') r = await runCommandCheck(check.spec, commandCapMs, cwd);
      else if (kind === 'file') r = runFileCheck(check.spec, cwd);
      else if (kind === 'http') r = await runHttpCheck(check.spec, httpTimeoutMs, keep);
      else r = { ok: false, detail: `unknown check kind ${JSON.stringify(kind)}` };
    } catch (e) {
      r = { ok: false, detail: errDetail(e) };
    }
    httpState.push(kind === 'http' ? { spec: check.spec, retryable: r.refused !== true } : null);
    out.push(toRow(id, kind, r, keep));
  }
  if (!httpRetry || typeof httpRetry !== 'object') return out;

  const { attempts, delayMs, sleep } = normalizeRetry(httpRetry);
  /** @type {number[]} */
  const ran = out.map(() => 1);
  for (let attempt = 2; attempt <= attempts; attempt++) {
    const due = [];
    for (let i = 0; i < out.length; i++) {
      const st = httpState[i];
      if (st && st.retryable && out[i].ok === false) due.push(i);
    }
    if (!due.length) break;
    await sleep(delayMs);
    for (const i of due) {
      const st = /** @type {{spec: unknown, retryable: boolean}} */ (httpState[i]);
      /** @type {HttpResult} */
      let r;
      try { r = await runHttpCheck(st.spec, httpTimeoutMs, keep); } catch (e) { r = { ok: false, detail: errDetail(e) }; }
      ran[i] = attempt;
      out[i] = toRow(out[i].id, out[i].kind, r, keep);
    }
  }
  for (let i = 0; i < out.length; i++) {
    if (httpState[i]) out[i].attempts = ran[i];
  }
  return out;
}

module.exports = { runCriteriaChecks, COMMAND_CAP_MS, HTTP_TIMEOUT_MS, HTTP_BODY_MAX_BYTES, HTTP_RETRY_ATTEMPTS, HTTP_RETRY_DELAY_MS };

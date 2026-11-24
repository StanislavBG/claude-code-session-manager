// @ts-check
/**
 * siteFeedbackAdminRoutes.cjs — loopback admin HTTP routes behind the Feedback MCP tools for
 * website-feedback widgets. Every route validates its input, then delegates to
 * siteFeedbackService (the one implementation shared with the desktop IPC):
 *   POST /admin/feedback-widget/create {cwd, label, allowedOrigins}      -> { ok, boxId, fingerprint, snippet }
 *   GET  /admin/feedback-widget/list?cwd=                                -> { ok, widgets, relayError? }
 *   POST /admin/feedback-widget/update {boxId, label?, allowedOrigins?, state?} -> { ok, widget }
 *   POST /admin/feedback-widget/delete {boxId}                           -> { ok, boxId }
 *   GET  /admin/feedback-widget/snippet?boxId=                           -> { ok, boxId, fingerprint, snippet }
 *   GET  /admin/site-feedback/inbox?cwd=&status=                         -> { ok, items }
 *   GET  /admin/site-feedback/item?cwd=&id=                              -> { ok, item: { meta, report, imagePaths } }
 *   POST /admin/site-feedback/status {cwd, id, status, note?}            -> { ok, meta }
 *
 * Failures are `{ ok: false, error, message? }`. Responses pass through redactSecrets
 * (siteFeedbackIpc.cjs), so a box private key or the device token can never leave here; the
 * item route returns local image paths only, never image bytes or data URLs.
 * Deliberately NO route that mints an Epic (SINGLE-CREATOR LAW, epicMint.cjs).
 */
'use strict';

const path = require('path');
const { readBody, sendJson } = require('./localAdminHttp.cjs');
const { redactSecrets } = require('./siteFeedbackIpc.cjs');

const HOST_ID_RE = /^FB-[0-9A-Z]{5}$/;
const BOX_ID_RE = /^[A-Za-z0-9_-]{1,200}$/;
const STATUSES = /** @type {const} */ (['open', 'in_progress', 'resolved', 'wontfix']);
const WIDGET_STATES = /** @type {const} */ (['open', 'paused']);
const MAX_LABEL = 80;
const MAX_NOTE = 500;
/** Keys that carry image bytes; stripped from every response on top of redactSecrets. */
const BYTE_KEYS = new Set(['dataurl', 'bytes', 'buffer', 'screenshotbytes', 'annotatedbytes']);

class InputError extends Error {}

/** @param {any} dep */
function getService(dep) {
  return dep || require('./siteFeedbackService.cjs');
}

/** @param {unknown} v @returns {string} */
function requireCwd(v) {
  if (typeof v !== 'string' || !v || v.length > 4096 || !path.isAbsolute(v)) {
    throw new InputError('cwd must be an absolute path');
  }
  return v;
}

/** @param {unknown} v @returns {string} */
function requireBoxId(v) {
  if (typeof v !== 'string' || !BOX_ID_RE.test(v)) throw new InputError('boxId is required (letters, digits, _ or -)');
  return v;
}

/** @param {unknown} v @returns {string} */
function requireHostId(v) {
  if (typeof v !== 'string' || !HOST_ID_RE.test(v)) throw new InputError('id must match FB-XXXXX (5 of 0-9, A-Z)');
  return v;
}

/** @param {unknown} v @returns {typeof STATUSES[number]} */
function requireStatus(v) {
  if (typeof v !== 'string' || !(/** @type {readonly string[]} */ (STATUSES)).includes(v)) {
    throw new InputError(`status must be one of: ${STATUSES.join(', ')}`);
  }
  return /** @type {typeof STATUSES[number]} */ (v);
}

/** @param {unknown} v @returns {string} */
function requireLabel(v) {
  const s = typeof v === 'string' ? v.trim() : '';
  if (s.length < 1 || s.length > MAX_LABEL) throw new InputError(`label must be 1-${MAX_LABEL} characters`);
  return s;
}

/**
 * The origins rule: 1-10 origins, each https:, or http://localhost / http://127.0.0.1.
 * Uses the service's own normaliser so the route and the service can never disagree.
 * @param {unknown} v
 * @returns {string[]}
 */
function requireOrigins(v) {
  const { normalizeOrigins } = require('./siteFeedbackService.cjs');
  const r = normalizeOrigins(v);
  if (!r.ok) throw new InputError(r.message);
  return r.origins;
}

/**
 * Deep copy without secret-named fields or image bytes.
 * @param {unknown} value
 * @returns {any}
 */
function scrub(value) {
  /** @param {unknown} v @returns {any} */
  const strip = (v) => {
    if (Array.isArray(v)) return v.map(strip);
    if (v && typeof v === 'object') {
      /** @type {Record<string, unknown>} */
      const out = {};
      for (const [k, x] of Object.entries(v)) {
        if (BYTE_KEYS.has(k.toLowerCase())) continue;
        if (typeof x === 'string' && /^data:image\//i.test(x)) continue;
        out[k] = strip(x);
      }
      return out;
    }
    return v;
  };
  return strip(redactSecrets(value));
}

/** @param {any} res @param {any} result */
function sendResult(res, result) {
  if (!result || typeof result !== 'object') {
    sendJson(res, 500, { ok: false, error: 'internal', message: 'the service returned no result' });
    return;
  }
  sendJson(res, 200, scrub(result));
}

/** @param {any} req @returns {Promise<Record<string, unknown>>} */
async function readJsonBody(req) {
  let raw;
  try {
    raw = await readBody(req);
  } catch (/** @type {any} */ e) {
    throw new InputError(`request body rejected: ${e?.message ?? 'unreadable'}`);
  }
  /** @type {any} */
  let body;
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {
    throw new InputError('invalid JSON body');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new InputError('body must be a JSON object');
  return body;
}

/**
 * Wrap a handler: InputError -> 400 { ok:false, error }, anything else -> 500.
 * @param {(req: any, query: URLSearchParams) => Promise<unknown>} fn
 */
function route(fn) {
  return async (/** @type {any} */ req, /** @type {any} */ res, /** @type {URLSearchParams} */ query) => {
    try {
      sendResult(res, await fn(req, query || new URLSearchParams()));
    } catch (e) {
      if (e instanceof InputError) {
        sendJson(res, 400, { ok: false, error: e.message });
        return;
      }
      sendJson(res, 500, { ok: false, error: 'internal', message: e instanceof Error ? e.message : 'request failed' });
    }
  };
}

/**
 * @param {any} adminHttp
 * @param {{ service?: any }} [opts] test seam
 */
function registerAdminRoute(adminHttp, opts = {}) {
  const svc = () => getService(opts.service);

  adminHttp.registerRoute('POST', '/admin/feedback-widget/create', route(async (req) => {
    const b = await readJsonBody(req);
    const cwd = requireCwd(b.cwd);
    const label = requireLabel(b.label);
    const allowedOrigins = requireOrigins(b.allowedOrigins);
    return svc().createWidget({ cwd, label, allowedOrigins });
  }));

  adminHttp.registerRoute('GET', '/admin/feedback-widget/list', route(async (_req, q) => {
    const raw = q.get('cwd');
    return svc().listWidgets(raw ? { cwd: requireCwd(raw) } : {});
  }));

  adminHttp.registerRoute('POST', '/admin/feedback-widget/update', route(async (req) => {
    const b = await readJsonBody(req);
    /** @type {{ boxId: string, label?: string, allowedOrigins?: string[], state?: 'open'|'paused' }} */
    const patch = { boxId: requireBoxId(b.boxId) };
    if (b.label !== undefined) patch.label = requireLabel(b.label);
    if (b.allowedOrigins !== undefined) patch.allowedOrigins = requireOrigins(b.allowedOrigins);
    if (b.state !== undefined) {
      if (typeof b.state !== 'string' || !(/** @type {readonly string[]} */ (WIDGET_STATES)).includes(b.state)) {
        throw new InputError("state must be 'open' or 'paused'");
      }
      patch.state = /** @type {'open'|'paused'} */ (b.state);
    }
    if (Object.keys(patch).length === 1) throw new InputError('Nothing to update: give label, allowedOrigins or state');
    return svc().updateWidget(patch);
  }));

  adminHttp.registerRoute('POST', '/admin/feedback-widget/delete', route(async (req) => {
    const b = await readJsonBody(req);
    return svc().deleteWidget({ boxId: requireBoxId(b.boxId) });
  }));

  adminHttp.registerRoute('GET', '/admin/feedback-widget/snippet', route(async (_req, q) => (
    svc().getSnippet({ boxId: requireBoxId(q.get('boxId')) })
  )));

  adminHttp.registerRoute('GET', '/admin/site-feedback/inbox', route(async (_req, q) => {
    const cwd = requireCwd(q.get('cwd'));
    const rawStatus = q.get('status');
    return svc().listItems(rawStatus ? { cwd, status: requireStatus(rawStatus) } : { cwd });
  }));

  adminHttp.registerRoute('GET', '/admin/site-feedback/item', route(async (_req, q) => {
    const cwd = requireCwd(q.get('cwd'));
    const hostId = requireHostId(q.get('id'));
    return svc().getItem({ cwd, hostId });
  }));

  adminHttp.registerRoute('POST', '/admin/site-feedback/status', route(async (req) => {
    const b = await readJsonBody(req);
    const cwd = requireCwd(b.cwd);
    const hostId = requireHostId(b.id);
    const status = requireStatus(b.status);
    if (b.note !== undefined && b.note !== null && (typeof b.note !== 'string' || b.note.length > MAX_NOTE)) {
      throw new InputError(`note must be a string of at most ${MAX_NOTE} characters`);
    }
    return svc().setStatus({ cwd, hostId, status, note: typeof b.note === 'string' ? b.note : null });
  }));
}

module.exports = { registerAdminRoute };

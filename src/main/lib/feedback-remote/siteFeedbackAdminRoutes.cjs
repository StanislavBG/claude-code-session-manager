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
 *   GET  /admin/site-feedback/inbox?cwd=&status=                         -> { ok, items: [{ id, hostId, ... }] }
 *   GET  /admin/site-feedback/item?cwd=&id=                              -> { ok, item: { meta, report, imagePaths, reporterVerified } }
 *   POST /admin/site-feedback/status {cwd, id, status, note?}            -> { ok, meta }
 *
 * Failures are `{ ok: false, error, message? }` with an HTTP status from httpStatusFor():
 * input errors 400, not_found 404, not_linked / not_enabled 409, relay or upstream failures 502,
 * local faults 500. Inbox list items carry `id` (= hostId, kept too) — the id the item and status
 * routes take. Responses drop Session Manager's OWN secrets (box private key, device token —
 * OWN_SECRET_KEYS) and image bytes; the visitor's Report v1 under item.report is returned exactly
 * as stored (a visitor field named `token` or `secret` is report content, not our secret). The
 * item route returns local image paths only, never image bytes, and lifts meta.reporterVerified
 * (true = signed by the site, false = signature did not match, null = claimed by site / legacy
 * item) onto item.reporterVerified so customer_feedback_get shows it without reading meta.
 * The three /admin/site-feedback/* routes answer 404 `unknown_project` for a cwd that is not the
 * projectCwd of a widget box (feedbackBoxKeys.listBoxes), before any inbox call — so an admin
 * call can never point the inbox (and its write-boundary widening) at an arbitrary directory.
 * Deliberately NO route that mints an Epic (SINGLE-CREATOR LAW, epicMint.cjs).
 */
'use strict';

const path = require('path');
const { readBody, sendJson } = require('./localAdminHttp.cjs');

const HOST_ID_RE = /^FB-[0-9A-Z]{5}$/;
const BOX_ID_RE = /^[A-Za-z0-9_-]{1,200}$/;
const STATUSES = /** @type {const} */ (['open', 'in_progress', 'resolved', 'wontfix']);
const WIDGET_STATES = /** @type {const} */ (['open', 'paused']);
const MAX_LABEL = 80;
const MAX_NOTE = 500;
/** Session Manager's own secrets (never a visitor's report field). Matched case-insensitively. */
const OWN_SECRET_KEYS = new Set(['privatekeyjwk', 'privatekey', 'devicetoken', 'identitysecret']);
/** Keys that carry image bytes; stripped from every response outside the stored report. */
const BYTE_KEYS = new Set(['dataurl', 'bytes', 'buffer', 'screenshotbytes', 'annotatedbytes']);
/** Service failure codes that are the caller's bad input. */
const INPUT_ERRORS = new Set(['invalid_input', 'invalid_label', 'invalid_allowed_origins', 'invalid_state']);
/** Service failure codes that are local faults, not the relay's. */
const LOCAL_ERRORS = new Set(['internal', 'keystore_failed', 'not_png']);
/** The desktop is in the wrong state for the request (pair / enable first). */
const CONFLICT_ERRORS = new Set(['not_linked', 'not_enabled']);

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
 * Deep copy without Session Manager's own secret fields or image bytes. `item.report` (the
 * visitor's stored Report v1) is passed through unmodified.
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
        const key = k.toLowerCase();
        if (OWN_SECRET_KEYS.has(key) || BYTE_KEYS.has(key)) continue;
        if (typeof x === 'string' && /^data:image\//i.test(x)) continue;
        out[k] = strip(x);
      }
      return out;
    }
    return v;
  };
  const out = strip(value);
  const item = /** @type {any} */ (value)?.item;
  if (item && typeof item === 'object' && !Array.isArray(item) && 'report' in item && out.item) {
    out.item.report = item.report;
  }
  return out;
}

/**
 * HTTP status for a service result: 200 on ok, else by failure code.
 * @param {any} result
 * @returns {number}
 */
function httpStatusFor(result) {
  if (result.ok !== false) return 200;
  const code = typeof result.error === 'string' ? result.error : '';
  if (CONFLICT_ERRORS.has(code)) return 409;
  if (INPUT_ERRORS.has(code)) return 400;
  if (code === 'not_found' || code === 'unknown_project') return 404;
  if (LOCAL_ERRORS.has(code)) return 500;
  return 502;
}

/** @param {any} res @param {any} result */
function sendResult(res, result) {
  if (!result || typeof result !== 'object') {
    sendJson(res, 500, { ok: false, error: 'internal', message: 'the service returned no result' });
    return;
  }
  if (result.ok === false && typeof result.error !== 'string') {
    sendJson(res, 502, { ok: false, error: 'upstream_failed', message: 'the service failed without an error code' });
    return;
  }
  sendJson(res, httpStatusFor(result), scrub(result));
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

/** Failure for a cwd with no widget box (HTTP 404). */
const UNKNOWN_PROJECT = Object.freeze({ ok: false, error: 'unknown_project', message: 'no feedback widget is set up for this project' });

/**
 * @param {any} adminHttp
 * @param {{ service?: any, boxKeys?: { listBoxes: (opts?: { projectCwd?: string }) => Promise<unknown[]> } }} [opts] test seams
 */
function registerAdminRoute(adminHttp, opts = {}) {
  const svc = () => getService(opts.service);
  const boxKeys = () => opts.boxKeys || require('./feedbackBoxKeys.cjs');
  /** @param {string} cwd */
  const knownProject = async (cwd) => {
    const boxes = await boxKeys().listBoxes();
    const abs = path.resolve(cwd);
    return boxes.some((/** @type {any} */ b) => b && typeof b.projectCwd === 'string' && path.resolve(b.projectCwd) === abs);
  };

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
    const status = rawStatus ? requireStatus(rawStatus) : undefined;
    if (!await knownProject(cwd)) return UNKNOWN_PROJECT;
    const r = await svc().listItems(status ? { cwd, status } : { cwd });
    if (r && r.ok !== false && Array.isArray(r.items)) {
      return { ...r, items: r.items.map((/** @type {any} */ it) => (it && typeof it === 'object' && typeof it.hostId === 'string' ? { ...it, id: it.hostId } : it)) };
    }
    return r;
  }));

  adminHttp.registerRoute('GET', '/admin/site-feedback/item', route(async (_req, q) => {
    const cwd = requireCwd(q.get('cwd'));
    const hostId = requireHostId(q.get('id'));
    if (!await knownProject(cwd)) return UNKNOWN_PROJECT;
    const r = await svc().getItem({ cwd, hostId });
    const item = r && r.ok !== false ? r.item : null;
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      const v = item.meta && typeof item.meta === 'object' ? item.meta.reporterVerified : undefined;
      return { ...r, item: { ...item, reporterVerified: typeof v === 'boolean' ? v : null } };
    }
    return r;
  }));

  adminHttp.registerRoute('POST', '/admin/site-feedback/status', route(async (req) => {
    const b = await readJsonBody(req);
    const cwd = requireCwd(b.cwd);
    const hostId = requireHostId(b.id);
    const status = requireStatus(b.status);
    if (b.note !== undefined && b.note !== null && (typeof b.note !== 'string' || b.note.length > MAX_NOTE)) {
      throw new InputError(`note must be a string of at most ${MAX_NOTE} characters`);
    }
    if (!await knownProject(cwd)) return UNKNOWN_PROJECT;
    return svc().setStatus({ cwd, hostId, status, note: typeof b.note === 'string' ? b.note : null });
  }));
}

module.exports = { registerAdminRoute };

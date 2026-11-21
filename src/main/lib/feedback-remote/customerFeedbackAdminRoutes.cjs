// @ts-check
/**
 * customerFeedbackAdminRoutes.cjs — loopback admin HTTP routes so an agent
 * session (via the scheduler MCP) can inspect and resolve customer feedback
 * through customerFeedbackInbox.cjs:
 *   GET  /admin/customer-feedback/inbox?pull=1&includeHidden=1 -> { ok, items, pulled? }
 *   POST /admin/customer-feedback/status {id, status, note?}   -> { ok, item }
 *   POST /admin/customer-feedback/submit {title, body, tag, imagePaths?} -> { ok, item, warning? } | { ok:false, error }
 *
 * submit is the customer path (no owner token needed): it runs the exact
 * submit the Feedback panel's customerFeedback:submit IPC uses
 * (customerFeedbackIpc.submitFeedback -> customerFeedbackClient.submit), so the
 * item + receipt land in the same local mirror. os.homedir() is replaced with
 * `~` in title and body first; the body text is never echoed or logged.
 * imagePaths (absolute only) are prepared by submitFeedback; image bytes are
 * never logged or echoed.
 *
 * Deliberately NO route that mints an Epic (SINGLE-CREATOR LAW, epicMint.cjs).
 * Responses never carry the owner token — the inbox lib redacts it from errors.
 */
'use strict';

const path = require('path');
const { readBody, sendJson } = require('./localAdminHttp.cjs');

/** @param {any} dep */
function getInbox(dep) {
  return dep || require('./customerFeedbackInbox.cjs');
}

/** @param {any} inboxDep */
function inboxHandler(inboxDep) {
  return async (/** @type {any} */ _req, /** @type {any} */ res, /** @type {URLSearchParams} */ query) => {
    const inbox = getInbox(inboxDep);
    const wantPull = query.get('pull') === '1';
    const includeHidden = query.get('includeHidden') === '1';
    /** @type {any} */
    let pulled;
    if (wantPull) {
      pulled = await inbox.pull();
      if (!pulled.ok) {
        sendJson(res, 200, { ok: false, error: pulled.error });
        return;
      }
    }
    const result = await inbox.list({ includeHidden });
    if (!result.ok) {
      sendJson(res, 200, { ok: false, error: result.error });
      return;
    }
    sendJson(res, 200, { ok: true, items: result.items, ...(wantPull ? { pulled: { fetched: pulled.fetched, pages: pulled.pages } } : {}) });
  };
}

/** @param {any} inboxDep */
function statusHandler(inboxDep) {
  return async (/** @type {any} */ req, /** @type {any} */ res) => {
    const inbox = getInbox(inboxDep);
    let raw;
    try {
      raw = await readBody(req);
    } catch (/** @type {any} */ e) {
      sendJson(res, 400, { ok: false, error: `request body rejected: ${e?.message ?? 'unreadable'}` });
      return;
    }
    /** @type {any} */
    let body;
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      sendJson(res, 400, { ok: false, error: 'invalid JSON body' });
      return;
    }
    if (!body || typeof body !== 'object' || typeof body.id !== 'string' || !body.id) {
      sendJson(res, 400, { ok: false, error: 'id is required' });
      return;
    }
    if (typeof body.status !== 'string' || !inbox.STATUSES.includes(body.status)) {
      sendJson(res, 400, { ok: false, error: `status must be one of: ${inbox.STATUSES.join(', ')}` });
      return;
    }
    if (body.note !== undefined && body.note !== null && typeof body.note !== 'string') {
      sendJson(res, 400, { ok: false, error: 'note must be a string' });
      return;
    }
    const result = await inbox.setStatus(body.id, body.status, body.note ?? undefined);
    if (!result.ok) {
      sendJson(res, 200, { ok: false, error: result.error });
      return;
    }
    sendJson(res, 200, { ok: true, item: result.item });
  };
}

/** Replace every occurrence of the home dir with `~`. @param {string} s */
function redactHome(s) {
  const home = require('os').homedir();
  return home ? s.split(home).join('~') : s;
}

/** @param {any} submitDep */
function submitHandler(submitDep) {
  return async (/** @type {any} */ req, /** @type {any} */ res) => {
    try {
      let raw;
      try {
        raw = await readBody(req);
      } catch (/** @type {any} */ e) {
        sendJson(res, 400, { ok: false, error: `request body rejected: ${e?.message ?? 'unreadable'}` });
        return;
      }
      /** @type {any} */
      let body;
      try {
        body = raw ? JSON.parse(raw) : {};
      } catch {
        sendJson(res, 400, { ok: false, error: 'invalid JSON body' });
        return;
      }
      const { schemas } = require('../../ipcSchemas.cjs');
      const parsed = schemas.customerFeedbackSubmit.safeParse(body);
      if (!parsed.success) {
        // Issue paths + messages only — never the submitted values.
        const error = parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ');
        sendJson(res, 400, { ok: false, error: `invalid submission: ${error}` });
        return;
      }
      const submit = submitDep || require('./customerFeedbackIpc.cjs').submitFeedback;
      const { title, body: text, tag, imagePaths } = parsed.data;
      if (imagePaths && !imagePaths.every((x) => path.isAbsolute(x))) {
        sendJson(res, 400, { ok: false, error: 'imagePaths must be absolute paths' });
        return;
      }
      const result = await submit({
        title: redactHome(title), body: redactHome(text), tag,
        ...(imagePaths && imagePaths.length ? { imagePaths } : {}),
      });
      if (!result || !result.ok) {
        sendJson(res, 502, { ok: false, error: result && typeof result.error === 'string' ? result.error : 'submit failed' });
        return;
      }
      sendJson(res, 200, { ok: true, item: result.item, ...(typeof result.warning === 'string' && result.warning ? { warning: result.warning } : {}) });
    } catch (/** @type {any} */ e) {
      sendJson(res, 500, { ok: false, error: e && e.message ? String(e.message) : 'submit failed' });
    }
  };
}

/**
 * @param {any} adminHttp
 * @param {{ inbox?: any, submit?: (p: { title: string, body: string, tag: string, imagePaths?: string[] }) => Promise<any> }} [opts] test seams
 */
function registerAdminRoute(adminHttp, opts = {}) {
  adminHttp.registerRoute('GET', '/admin/customer-feedback/inbox', inboxHandler(opts.inbox));
  adminHttp.registerRoute('POST', '/admin/customer-feedback/status', statusHandler(opts.inbox));
  adminHttp.registerRoute('POST', '/admin/customer-feedback/submit', submitHandler(opts.submit));
}

module.exports = { registerAdminRoute };

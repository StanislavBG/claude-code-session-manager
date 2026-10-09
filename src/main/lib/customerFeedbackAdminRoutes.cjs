// @ts-check
/**
 * customerFeedbackAdminRoutes.cjs — loopback admin HTTP routes so an agent
 * session (via the scheduler MCP) can inspect and resolve customer feedback
 * through customerFeedbackInbox.cjs:
 *   GET  /admin/customer-feedback/inbox?pull=1&includeHidden=1 -> { ok, items, pulled? }
 *   POST /admin/customer-feedback/status {id, status, note?}   -> { ok, item }
 *
 * Deliberately NO route that mints an Epic (SINGLE-CREATOR LAW, epicMint.cjs).
 * Responses never carry the owner token — the inbox lib redacts it from errors.
 */
'use strict';

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

/**
 * @param {any} adminHttp
 * @param {{ inbox?: any }} [opts] test seam
 */
function registerAdminRoute(adminHttp, opts = {}) {
  adminHttp.registerRoute('GET', '/admin/customer-feedback/inbox', inboxHandler(opts.inbox));
  adminHttp.registerRoute('POST', '/admin/customer-feedback/status', statusHandler(opts.inbox));
}

module.exports = { registerAdminRoute };

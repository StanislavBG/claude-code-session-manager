'use strict';

/**
 * needsYouAdminRoutes.cjs — loopback admin HTTP routes so an outside app on
 * this machine can put a "Needs you" item in front of the owner, take it back,
 * and list its items, through needsYouStore.cjs:
 *   POST /admin/needs-you          {app, id, title, why?, link?, options?, externalRef?}
 *                                  -> 200 { ok, item, created } | 400 | 429 (item limit)
 *   POST /admin/needs-you/withdraw {app, id} -> 200 { ok, item } | 404 { ok:false, error:'not found' }
 *   GET  /admin/needs-you?app=&status=       -> 200 { ok, items }
 *
 * A post that created or changed an item appends one `needs_you_posted` audit
 * row and calls deps.onChanged once; a post that changed nothing (an identical
 * re-post, or an item already answered/withdrawn) writes no row and does not
 * call it. A withdrawal appends `needs_you_withdrawn` and calls onChanged once.
 * Answering is the human's, in the app — no route here.
 */

const { readBody, sendJson } = require('./localAdminHttp.cjs');
const needsYouStore = require('./needsYouStore.cjs');
const { appendAuditEvent } = require('../telemetry/auditLog.cjs');

const STATUSES = ['open', 'answered', 'withdrawn'];

/** Read + parse a JSON object body; on failure sends the 400 and returns null. */
async function readJsonBody(req, res) {
  let raw;
  try {
    raw = await readBody(req);
  } catch (e) {
    sendJson(res, 400, { ok: false, error: `request body rejected: ${e?.message ?? 'unreadable'}` });
    return null;
  }
  let body;
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {
    sendJson(res, 400, { ok: false, error: 'invalid JSON body' });
    return null;
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    sendJson(res, 400, { ok: false, error: 'invalid JSON body' });
    return null;
  }
  return body;
}

function firstIssue(e, fallback) {
  return e?.issues?.[0]?.message ?? e?.message ?? fallback;
}

/** The fields a post may change on an existing open item. */
function contentKey(item) {
  return JSON.stringify([item.title, item.why, item.link, item.options, item.status]);
}

function postHandler(onChanged) {
  return async (req, res) => {
    const body = await readJsonBody(req, res);
    if (!body) return;
    let input;
    try {
      input = needsYouStore.NeedsYouPostSchema.parse(body);
    } catch (e) {
      sendJson(res, 400, { ok: false, error: firstIssue(e, 'invalid payload') });
      return;
    }
    const before = (await needsYouStore.listNeedsYou({ app: input.app })).find((it) => it.id === input.id);
    let result;
    try {
      result = await needsYouStore.postNeedsYou(body);
    } catch (e) {
      if (e?.code === 'NEEDS_YOU_LIMIT') {
        sendJson(res, 429, { ok: false, error: e.message });
        return;
      }
      if (Array.isArray(e?.issues)) {
        sendJson(res, 400, { ok: false, error: firstIssue(e, 'invalid payload') });
        return;
      }
      sendJson(res, 500, { ok: false, error: e?.message ?? 'post failed' });
      return;
    }
    const { item, created } = result;
    const changed = created || !before || contentKey(before) !== contentKey(item);
    if (changed) {
      appendAuditEvent('needs_you_posted', {
        route: '/admin/needs-you',
        app: item.app,
        id: item.id,
        externalRef: item.externalRef,
        created,
      });
      if (onChanged) onChanged();
    }
    sendJson(res, 200, { ok: true, item, created });
  };
}

function withdrawHandler(onChanged) {
  return async (req, res) => {
    const body = await readJsonBody(req, res);
    if (!body) return;
    let item;
    try {
      item = await needsYouStore.withdrawNeedsYou({ app: body.app, id: body.id });
    } catch (e) {
      if (Array.isArray(e?.issues)) {
        sendJson(res, 400, { ok: false, error: firstIssue(e, 'invalid payload') });
        return;
      }
      sendJson(res, 500, { ok: false, error: e?.message ?? 'withdraw failed' });
      return;
    }
    if (!item) {
      sendJson(res, 404, { ok: false, error: 'not found' });
      return;
    }
    appendAuditEvent('needs_you_withdrawn', { route: '/admin/needs-you/withdraw', app: item.app, id: item.id });
    if (onChanged) onChanged();
    sendJson(res, 200, { ok: true, item });
  };
}

function listHandler() {
  return async (_req, res, query) => {
    const app = query.get('app') || undefined;
    const status = query.get('status') || undefined;
    if (status !== undefined && !STATUSES.includes(status)) {
      sendJson(res, 400, { ok: false, error: `status must be one of ${STATUSES.join(', ')}` });
      return;
    }
    const items = await needsYouStore.listNeedsYou({ app, status });
    sendJson(res, 200, { ok: true, items });
  };
}

/** @param {{ onChanged?: () => void }} deps */
function registerAdminRoute(adminHttp, deps = {}) {
  const { onChanged } = deps;
  adminHttp.registerRoute('GET', '/admin/needs-you', listHandler());
  adminHttp.registerRoute('POST', '/admin/needs-you', postHandler(onChanged));
  adminHttp.registerRoute('POST', '/admin/needs-you/withdraw', withdrawHandler(onChanged));
}

module.exports = { registerAdminRoute };

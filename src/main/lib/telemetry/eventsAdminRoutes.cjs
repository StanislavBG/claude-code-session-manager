/**
 * eventsAdminRoutes.cjs — read-only admin HTTP route over auditEvents.cjs's
 * cursor reader, so an outside script can ask for the events after its saved
 * cursor instead of polling every Epic.
 *
 *   GET /admin/events?after=<cursor|start>&kinds=<k1,k2>&limit=<1..500>
 *     → 200 { ok: true, events, next, more, gap }
 *     → 400 { ok: false, error: 'invalid query', details } for an unknown kind,
 *       an out-of-range limit, or a cursor readEventsAfter rejects.
 *
 * Writes no file and no audit row. Auth/loopback binding are the injected
 * localAdminHttp.cjs transport's job (see index.cjs).
 */
'use strict';

const { schemas } = require('../../ipcSchemas.cjs');
const { sendJson } = require('../feedback-remote/localAdminHttp.cjs');
const { readEventsAfter, INVALID_AUDIT_CURSOR } = require('./auditEvents.cjs');

/** @param {{ registerRoute: Function }} adminHttp */
function registerAdminRoute(adminHttp) {
  adminHttp.registerRoute('GET', '/admin/events', async (req, res, query) => {
    let input;
    try {
      input = schemas.adminListEventsQuery.parse(Object.fromEntries(query ?? []));
    } catch (e) {
      sendJson(res, 400, { ok: false, error: 'invalid query', details: e?.issues ?? e?.message });
      return;
    }
    let result;
    try {
      result = readEventsAfter({ after: input.after, kinds: input.kinds, limit: input.limit });
    } catch (e) {
      if (e instanceof Error && /** @type {Error & { code?: unknown }} */ (e).code === INVALID_AUDIT_CURSOR) {
        sendJson(res, 400, { ok: false, error: 'invalid query', details: e.message });
        return;
      }
      throw e;
    }
    const { events, next, more, gap } = result;
    sendJson(res, 200, { ok: true, events, next, more, gap });
  });
}

module.exports = { registerAdminRoute };

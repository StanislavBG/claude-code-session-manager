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
 *   GET /admin/events?epicId=<id>[&cwd=<abs>][&after=<seq|start>][&kinds=<k1,k2>][&limit=<n>]
 *     → 200 { ok: true, events, cursor, hasMore } — replay of every event kind of
 *       that Epic from its per-Epic event log (lib/epic/epicEventLog.cjs
 *       readEpicEvents). `after` = the `cursor` (seq integer) of the previous
 *       page; absent or 'start' = from the first event. `kinds` filters to a
 *       subset of epicEventLog's EVENT_KINDS; `limit` defaults to 100 and is
 *       capped at 500. No cwd → the Epic's project is found among the
 *       registered projects (findEpicProject); an Epic no project holds → an
 *       empty page { events: [], cursor: <after>, hasMore: false }; one held by
 *       several → 409 { ok: false, error: 'ambiguous epic id', cwds }.
 *     → 400 { ok: false, error: 'invalid query', details } for a malformed
 *       epicId, cursor, kind, limit or cwd.
 *   Calls without epicId take the audit-log path above, unchanged.
 *
 * Writes no file and no audit row. Auth/loopback binding are the injected
 * localAdminHttp.cjs transport's job (see index.cjs).
 */
'use strict';

const path = require('node:path');
const { schemas } = require('../../ipcSchemas.cjs');
const { sendJson } = require('../feedback-remote/localAdminHttp.cjs');
const { readEventsAfter, INVALID_AUDIT_CURSOR } = require('./auditEvents.cjs');

const EPIC_MAX_LIMIT = 500;
const EPIC_DEFAULT_LIMIT = 100;
const EPIC_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const SEQ_CURSOR_RE = /^(?:0|[1-9]\d{0,15})$/;

/**
 * Parse the epic-mode query by hand (the audit-mode schema strips unknown keys).
 * @param {Record<string, string>} q
 * @returns {{ ok: true, value: { epicId: string, cwd?: string, after: number, kinds?: string[], limit: number } } | { ok: false, details: string }}
 */
function parseEpicQuery(q) {
  const { EVENT_KINDS } = require('../epic/epicEventLog.cjs');
  const epicId = q.epicId;
  if (typeof epicId !== 'string' || !EPIC_ID_RE.test(epicId)) return { ok: false, details: 'epicId must match [A-Za-z0-9][A-Za-z0-9_-]{0,127}' };
  let cwd;
  if (q.cwd !== undefined) {
    if (typeof q.cwd !== 'string' || q.cwd.length > 4096 || !path.isAbsolute(q.cwd)) return { ok: false, details: 'cwd must be an absolute path' };
    cwd = q.cwd;
  }
  let after = 0;
  if (q.after !== undefined && q.after !== 'start') {
    if (typeof q.after !== 'string' || !SEQ_CURSOR_RE.test(q.after)) {
      return { ok: false, details: `invalid epic event cursor ${JSON.stringify(q.after)}: expected a non-negative integer seq or 'start'` };
    }
    after = Number(q.after);
  }
  let kinds;
  if (q.kinds !== undefined) {
    kinds = String(q.kinds).split(',').map((k) => k.trim());
    const known = new Set(EVENT_KINDS);
    const bad = kinds.filter((k) => !known.has(k));
    if (!kinds.length || bad.length) return { ok: false, details: `unknown event kind(s): ${bad.join(', ') || '(empty)'}` };
  }
  let limit = EPIC_DEFAULT_LIMIT;
  if (q.limit !== undefined) {
    if (!/^\d{1,9}$/.test(String(q.limit)) || Number(q.limit) < 1) return { ok: false, details: 'limit must be a positive integer' };
    limit = Math.min(Number(q.limit), EPIC_MAX_LIMIT);
  }
  return { ok: true, value: { epicId, cwd, after, kinds, limit } };
}

/**
 * @param {any} res @param {Record<string, string>} q
 * @param {{ projectRoots?: () => string[] }} deps
 */
async function serveEpicEvents(res, q, deps) {
  const parsed = parseEpicQuery(q);
  if (!parsed.ok) {
    sendJson(res, 400, { ok: false, error: 'invalid query', details: parsed.details });
    return;
  }
  const { epicId, after, kinds, limit } = parsed.value;
  let cwd = parsed.value.cwd;
  if (cwd === undefined) {
    const { findEpicProject } = require('../epic/epicOutsideRead.cjs');
    const found = findEpicProject(epicId, typeof deps.projectRoots === 'function' ? { projectRoots: deps.projectRoots } : {});
    if (found && 'ambiguous' in found) {
      sendJson(res, 409, { ok: false, error: 'ambiguous epic id', cwds: found.ambiguous });
      return;
    }
    if (!found) {
      sendJson(res, 200, { ok: true, events: [], cursor: after, hasMore: false });
      return;
    }
    cwd = found.cwd;
  }
  const { readEpicEvents } = require('../epic/epicEventLog.cjs');
  let page;
  try {
    page = await readEpicEvents(cwd, epicId, { after, kinds, limit });
  } catch (e) {
    sendJson(res, 400, { ok: false, error: 'invalid query', details: e instanceof Error ? e.message : String(e) });
    return;
  }
  const { events, cursor, hasMore } = page;
  sendJson(res, 200, { ok: true, events, cursor, hasMore });
}

/**
 * @param {{ registerRoute: Function }} adminHttp
 * @param {{ projectRoots?: () => string[] }} [deps] projectRoots overrides the registered-project list (tests)
 */
function registerAdminRoute(adminHttp, deps = {}) {
  adminHttp.registerRoute('GET', '/admin/events', async (req, res, query) => {
    const raw = Object.fromEntries(query ?? []);
    if (raw.epicId !== undefined) {
      await serveEpicEvents(res, raw, deps);
      return;
    }
    let input;
    try {
      input = schemas.adminListEventsQuery.parse(raw);
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

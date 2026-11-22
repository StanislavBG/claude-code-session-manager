/**
 * epicAdminRoutes.cjs — read-only admin HTTP routes over epicOutsideRead.cjs,
 * so a script or another project can read an Epic's state without touching
 * Session Manager's files.
 *
 *   GET /admin/epics?cwd=<abs>&state=<state>&limit=<1..200>&offset=<0..>
 *     → 200 { ok: true, epics, total, limit, offset, hasMore }
 *   GET /admin/epic?cwd=<abs>&(id=<epicId> | externalRef=<ref>)[&receipt=1|true]
 *     → 200 { ok: true, epic } (epic.receipt = { jobs, chat } only when receipt was asked for) | 404 { ok: false, error: 'not found' }
 *   GET /admin/epic?id=<epicId>[&receipt=1|true]   (no cwd)
 *     → the Epic is found among the registered projects (findEpicProject):
 *       one → as above; none → 404; several → 409 { ok: false, error: 'ambiguous epic id', cwds }
 *
 * A query the schema rejects → 400 { ok: false, error: 'invalid query', details }.
 * A cwd that is not absolute or has no session-manager-operations folder →
 * 400 { ok: false, error: <reason> }.
 *
 * Writes no file and no audit row. Auth/loopback binding are the injected
 * localAdminHttp.cjs transport's job (see index.cjs).
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { schemas } = require('../../ipcSchemas.cjs');
const { sendJson } = require('../feedback-remote/localAdminHttp.cjs');
const { opsPath } = require('../opsOwnership.cjs');
const { listOpenEpicRecords, getEpicRecord, findEpicProject } = require('./epicOutsideRead.cjs');

/** @param {unknown} cwd @returns {string | null} the reason this cwd is not a project, or null. */
function projectProblem(cwd) {
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) return 'cwd must be an absolute path';
  let dir;
  try {
    dir = opsPath(cwd);
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  try {
    if (!fs.statSync(dir).isDirectory()) return 'cwd has no session-manager-operations folder';
  } catch {
    return 'cwd has no session-manager-operations folder';
  }
  return null;
}

/**
 * @param {{ registerRoute: Function }} adminHttp
 * @param {{ isTabBusy?: (epicId: string) => boolean | Promise<boolean>, listJobs?: () => any, projectRoots?: () => string[] }} [deps]
 */
function registerAdminRoute(adminHttp, deps = {}) {
  /** @type {Record<string, unknown>} */
  const readOpts = {};
  if (typeof deps.isTabBusy === 'function') readOpts.isTabBusy = deps.isTabBusy;
  if (typeof deps.listJobs === 'function') readOpts.listJobs = deps.listJobs;
  if (typeof deps.projectRoots === 'function') readOpts.projectRoots = deps.projectRoots;

  /**
   * @param {any} schema @param {any} query @param {any} res
   * @param {(input: any) => boolean} [cwdOptional] true when this input may omit cwd
   */
  function parseQuery(schema, query, res, cwdOptional) {
    let input;
    try {
      input = schema.parse(Object.fromEntries(query ?? []));
    } catch (e) {
      sendJson(res, 400, { ok: false, error: 'invalid query', details: e?.issues ?? e?.message });
      return null;
    }
    if (input.cwd === undefined && cwdOptional && cwdOptional(input)) return input;
    const problem = projectProblem(input.cwd);
    if (problem) {
      sendJson(res, 400, { ok: false, error: problem });
      return null;
    }
    return input;
  }

  adminHttp.registerRoute('GET', '/admin/epics', async (/** @type {any} */ req, /** @type {any} */ res, /** @type {any} */ query) => {
    const input = parseQuery(schemas.adminListEpicsQuery, query, res);
    if (!input) return;
    const { epics, total, limit, offset, hasMore } = await listOpenEpicRecords(input.cwd, {
      ...readOpts,
      state: input.state,
      limit: input.limit,
      offset: input.offset,
    });
    sendJson(res, 200, { ok: true, epics, total, limit, offset, hasMore });
  });

  adminHttp.registerRoute('GET', '/admin/epic', async (/** @type {any} */ req, /** @type {any} */ res, /** @type {any} */ query) => {
    const input = parseQuery(schemas.adminGetEpicQuery, query, res, (v) => v.id !== undefined);
    if (!input) return;
    let cwd = input.cwd;
    if (cwd === undefined) {
      const found = findEpicProject(input.id, readOpts.projectRoots ? { projectRoots: /** @type {() => string[]} */ (readOpts.projectRoots) } : {});
      if (found && 'ambiguous' in found) {
        sendJson(res, 409, { ok: false, error: 'ambiguous epic id', cwds: found.ambiguous });
        return;
      }
      if (!found) {
        sendJson(res, 404, { ok: false, error: 'not found' });
        return;
      }
      cwd = found.cwd;
    }
    const epic = await getEpicRecord(cwd, {
      ...readOpts,
      id: input.id,
      externalRef: input.externalRef,
      receipt: input.receipt === true,
    });
    if (!epic) {
      sendJson(res, 404, { ok: false, error: 'not found' });
      return;
    }
    sendJson(res, 200, { ok: true, epic });
  });
}

module.exports = { registerAdminRoute };

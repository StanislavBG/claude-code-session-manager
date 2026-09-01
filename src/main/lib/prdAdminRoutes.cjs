/**
 * prdAdminRoutes.cjs — admin HTTP routes closing the PRD-lifecycle capability
 * gap (PRD 1024, step 1 of locking the PRD entity behind the scheduler
 * service boundary — see that PRD's Goal). Before this file, the admin API
 * exposed only create-prd/jobs/reset-job/send-prompt: there was no way to
 * READ, LIST, EDIT, ARCHIVE, or CANCEL a PRD/job over HTTP, which is exactly
 * why direct filesystem access to session-manager-operations/scheduler/ was
 * still sanctioned. This file plumbs those operations to HTTP; it adds no
 * enforcement/denial of direct access — that's the dependent PRD's job (see
 * this PRD's "Out of scope").
 *
 * Every route here reuses an existing verified implementation rather than
 * reimplementing it:
 *   - list/get/update/cancel delegate to scheduler.cjs's `remote` object
 *     (job-status-aware; remote already owns the PRD-dir search + symlink
 *     defense patterns these need)
 *   - archive/retag delegate to queueOps.cjs's archiveMany/retagMany
 *     directly (job-status-agnostic bulk file ops; already used by the
 *     renderer's schedule:archive-prd/schedule:retag-prd IPC handlers)
 *
 * Registered against the same injected localAdminHttp.cjs transport as
 * scheduler.cjs's registerAdminRoutes and prdCreate.cjs's registerAdminRoute
 * (see index.cjs) — auth, loopback-only binding, and the bearer-token
 * lifecycle are all the transport's job, not this file's.
 */
'use strict';

const { schemas } = require('../ipcSchemas.cjs');
const { readBody, sendJson } = require('./localAdminHttp.cjs');
const { appendAuditEvent } = require('./auditLog.cjs');
const queueOps = require('../queueOps.cjs');
const { MCP_TOOL_CATALOG, MCP_RECIPES } = require('./mcpToolCatalog.cjs');
const { checkDelegationReadiness } = require('./delegationReadiness.cjs');
const { resolveProjectContext } = require('./projectRootResolve.cjs');

function parseJsonBody(raw) {
  try {
    return { ok: true, value: raw ? JSON.parse(raw) : {} };
  } catch {
    return { ok: false };
  }
}

/**
 * registerAdminRoute(adminHttp, remote) — `remote` is scheduler.cjs's
 * `remote` object, injected (not required directly) so this file stays
 * testable without booting Electron, matching prdCreate.cjs's and
 * scheduler.cjs's own registerAdminRoute(s) pattern.
 */
function registerAdminRoute(adminHttp, remote) {
  // GET /admin/mcp/catalog — read-only surface for mcpToolCatalog.cjs, the
  // single source of truth scheduler-mcp-server.cjs's tool descriptions are
  // now composed from (PRD: agent-facing help + Home-tab surface). No
  // `remote` dependency; kept in this file only because it registers
  // "alongside the existing PRD admin routes".
  adminHttp.registerRoute('GET', '/admin/mcp/catalog', async (req, res) => {
    sendJson(res, 200, { ok: true, tools: MCP_TOOL_CATALOG, recipes: MCP_RECIPES });
  });

  // GET /admin/mcp/readiness?cwd=... — session_manager_help's live half: the
  // catalog above is static and always answerable in-process, but "is this
  // MCP server actually wired up for this project" needs the same four
  // checks delegationReadiness.cjs already runs for the New Epic readiness
  // banner. `cwd` is a required query param (this server has no notion of
  // "the" project — one admin API instance serves every open tab/project).
  adminHttp.registerRoute('GET', '/admin/mcp/readiness', async (req, res, query) => {
    let input;
    try {
      input = schemas.delegationReadinessCwd.parse(Object.fromEntries(query ?? []));
    } catch (e) {
      sendJson(res, 400, { ok: false, error: 'invalid query', details: e?.issues ?? e?.message });
      return;
    }
    // Normalize a worktree/ops-internal cwd to its real project root first —
    // session_manager_help called from inside an Epic's worktree must report
    // THAT project's readiness, not a worktree checkout's own (nonexistent)
    // config state. See projectRootResolve.cjs's header.
    const resolved = resolveProjectContext({ cwd: input.cwd });
    const result = await checkDelegationReadiness({ cwd: resolved.cwd || input.cwd });
    // `ok: true` means "the route answered"; `ready`/`checks` carry the
    // actual delegation-readiness verdict — kept distinct so a caller can't
    // mistake "readiness is false" for "the request itself failed".
    sendJson(res, 200, { ok: true, ready: result.ok, checks: result.checks });
  });

  // GET /admin/scheduler/prds — paginated PRD listing (PRD: 353KB/120s
  // fix). Sort order is stable and explicit: slug ascending via
  // String.localeCompare(..., { numeric: true }) (listPrdsInternal in
  // scheduler.cjs), so offset paging can't skip or duplicate an entry
  // between calls as long as the underlying PRD set is unchanged.
  // `limit`/`offset` default to 100/0 (hard max limit 500); `total` is the
  // filtered count BEFORE the page slice, and `hasMore` is derived from
  // `total`, not from whether the page came back full. `fields=full` opts
  // into the secondary detail fields (parallelGroup, estimateMinutes,
  // sourcePromptId, epicId, archivedStatus) omitted by default.
  adminHttp.registerRoute('GET', '/admin/scheduler/prds', async (req, res, query) => {
    let input;
    try {
      input = schemas.adminListPrdsQuery.parse(Object.fromEntries(query ?? []));
    } catch (e) {
      sendJson(res, 400, { ok: false, error: 'invalid query', details: e?.issues ?? e?.message });
      return;
    }
    const { prds, total, limit, offset, hasMore } = await remote.listPrds(input);
    sendJson(res, 200, { ok: true, prds, total, limit, offset, hasMore });
  });

  adminHttp.registerRoute('GET', '/admin/scheduler/prd', async (req, res, query) => {
    let input;
    try {
      input = schemas.adminGetPrdQuery.parse(Object.fromEntries(query ?? []));
    } catch (e) {
      sendJson(res, 400, { ok: false, error: 'invalid query', details: e?.issues ?? e?.message });
      return;
    }
    const result = await remote.getPrdParsed(input.slug, input.cwd);
    if (!result.ok) {
      sendJson(res, 404, result);
      return;
    }
    sendJson(res, 200, result);
  });

  adminHttp.registerRoute('POST', '/admin/scheduler/update-prd', async (req, res) => {
    const raw = await readBody(req);
    const parsedBody = parseJsonBody(raw);
    if (!parsedBody.ok) {
      sendJson(res, 400, { ok: false, error: 'invalid JSON body' });
      return;
    }
    let input;
    try {
      input = schemas.adminUpdatePrd.parse(parsedBody.value);
    } catch (e) {
      sendJson(res, 400, { ok: false, error: 'invalid payload', details: e?.issues ?? e?.message });
      return;
    }
    const result = await remote.updatePrd(input);
    if (!result.ok) {
      const status = /not found/i.test(result.error ?? '') ? 404 : /status is/i.test(result.error ?? '') ? 409 : 400;
      sendJson(res, status, result);
      return;
    }
    appendAuditEvent('admin_prd_update', { route: '/admin/scheduler/update-prd', slug: input.slug, cwd: input.cwd ?? null });
    sendJson(res, 200, result);
  });

  adminHttp.registerRoute('POST', '/admin/scheduler/archive-prd', async (req, res) => {
    const raw = await readBody(req);
    const parsedBody = parseJsonBody(raw);
    if (!parsedBody.ok) {
      sendJson(res, 400, { ok: false, error: 'invalid JSON body' });
      return;
    }
    let input;
    try {
      input = schemas.scheduleArchivePrd.parse(parsedBody.value);
    } catch (e) {
      sendJson(res, 400, { ok: false, error: 'invalid payload', details: e?.issues ?? e?.message });
      return;
    }
    const result = await queueOps.archiveMany(input.slugs, input.cwd);
    // Audit only the slugs that actually archived — archiveMany's `results`
    // array carries the real per-slug outcome; logging every requested slug
    // regardless of whether it succeeded would misrepresent a partial-failure
    // batch as a clean one in audit-log.jsonl.
    for (const r of result.results ?? []) {
      if (!r.ok) continue;
      appendAuditEvent('admin_prd_archive', { route: '/admin/scheduler/archive-prd', slug: r.slug, cwd: null });
    }
    sendJson(res, result.ok ? 200 : 500, result);
  });

  adminHttp.registerRoute('POST', '/admin/scheduler/cancel-job', async (req, res) => {
    const raw = await readBody(req);
    const parsedBody = parseJsonBody(raw);
    if (!parsedBody.ok) {
      sendJson(res, 400, { ok: false, error: 'invalid JSON body' });
      return;
    }
    let input;
    try {
      input = schemas.adminCancelJob.parse(parsedBody.value);
    } catch (e) {
      sendJson(res, 400, { ok: false, error: 'invalid payload', details: e?.issues ?? e?.message });
      return;
    }
    const result = await remote.cancelJob(input.slug, { cwd: input.cwd });
    if (!result.ok) {
      const status = result.error === 'invalid slug' ? 400
        : /unknown slug|not found/i.test(result.error ?? '') ? 404
          : 409;
      sendJson(res, status, result);
      return;
    }
    appendAuditEvent('admin_job_cancel', { route: '/admin/scheduler/cancel-job', slug: input.slug, cwd: result.cwd ?? null });
    sendJson(res, 200, result);
  });

  adminHttp.registerRoute('POST', '/admin/scheduler/retag-prd', async (req, res) => {
    const raw = await readBody(req);
    const parsedBody = parseJsonBody(raw);
    if (!parsedBody.ok) {
      sendJson(res, 400, { ok: false, error: 'invalid JSON body' });
      return;
    }
    let input;
    try {
      input = schemas.scheduleRetagPrd.parse(parsedBody.value);
    } catch (e) {
      sendJson(res, 400, { ok: false, error: 'invalid payload', details: e?.issues ?? e?.message });
      return;
    }
    const result = await queueOps.retagMany(input.items);
    // Audit only the items that actually retagged (see the archive-prd route
    // above for why this must read result.results rather than the request).
    for (const r of result.results ?? []) {
      if (!r.ok) continue;
      appendAuditEvent('admin_prd_retag', { route: '/admin/scheduler/retag-prd', slug: r.newSlug ?? r.slug, cwd: null });
    }
    sendJson(res, result.ok ? 200 : 500, result);
  });
}

module.exports = { registerAdminRoute };

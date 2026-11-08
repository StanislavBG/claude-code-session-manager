/**
 * macroAdminRoutes.cjs — loopback admin HTTP routes so an agent session (via
 * the scheduler MCP) can list, create/update and delete a HOT KEYS macro
 * for its own project, through the existing macroLibrary.cjs store:
 *   GET  /admin/macros?cwd=…                          -> { ok, macros }
 *   POST /admin/macros/save  {cwd, id?, label, agentName, tag, prompt, inputs?}
 *   POST /admin/macros/delete {cwd, id, originClaudeSessionId?}
 *                                                     -> { ok, deleted, macro }
 * delete removes the macro from THIS project through
 * macroLibrary.removeMacroFromProject (deleted:false when other projects still
 * list it), fires onChanged once and appends one `admin_macro_delete` audit
 * event on success; every refusal is a 400 with no onChanged and no audit.
 *
 * cwd resolution matches projectHomeAdminRoutes.cjs's resolveCwd exactly
 * (reused, not copied). `surface` ('sessions' | 'project-home') is accepted on
 * create and update; a create defaults it to 'sessions' and `projects` to
 * [resolvedCwd]. A Project Home tool is part of Session Manager and shown in
 * every project's Project Home, so any save whose resulting surface is
 * 'project-home' stores projects ["*"]; only what it generates is per project.
 * `projects` is accepted ONLY as exactly ["*"] (show in every
 * project); anything else is a 400. An update without `projects` leaves them
 * unchanged. An update is refused (400) if the macro is not visible to the
 * resolved cwd (macroLibrary.macroVisibleIn, so '*' macros are reachable), if
 * `id` starts with `builtin-`, or if `id` is not found. Field validation
 * reuses macroLibrary's `MacroSaveSchema`.
 *
 * A save whose existing or resulting macro is shown in every project needs a
 * VERIFIED human request: body.humanRequestQuote must appear in a prompt the
 * human typed into body.originClaudeSessionId (humanPromptLedger) AND name
 * every/all projects (or, for a 'project-home' macro, Project Home). Otherwise 400, no write, no onChanged, no audit.
 *
 * Every successful save appends one `admin_macro_save` audit event and calls
 * `onChanged()` exactly once so the Sessions HOT KEYS strip updates live,
 * matching the IPC handlers in index.cjs.
 */
'use strict';

const { readBody, sendJson } = require('./localAdminHttp.cjs');
const { resolveCwd } = require('./projectHomeAdminRoutes.cjs');
const macroLibrary = require('../persona-macro/macroLibrary.cjs');
const { appendAuditEvent } = require('../telemetry/auditLog.cjs');
const { findHumanPromptContaining } = require('./humanPromptLedger.cjs');

const EVERY_PROJECT_RE = /(^|[^a-z0-9])(every|all|each)\s+(of\s+)?(my\s+|the\s+|our\s+)?projects?($|[^a-z0-9])/;

/** True when the quote asks for every/all projects (or "everywhere"). */
function quoteNamesEveryProject(quote) {
  if (typeof quote !== 'string') return false;
  const q = quote.toLowerCase().replace(/[-_]/g, ' ');
  return EVERY_PROJECT_RE.test(q) || /(^|[^a-z0-9])everywhere($|[^a-z0-9])/.test(q);
}

const PROJECT_HOME_RE = /(^|[^a-z0-9])project\s*home($|[^a-z0-9])/;

/** True when the quote names Project Home (project home / project-home / project_home). */
function quoteNamesProjectHome(quote) {
  if (typeof quote !== 'string') return false;
  const q = quote.toLowerCase().replace(/[-_]/g, ' ');
  return PROJECT_HOME_RE.test(q);
}

const HUMAN_HINT = "the human can set 'Show in every project' in the macro editor";
const PROJECT_HOME_HINT =
  "a Project Home tool is shown in every project's Project Home, so it needs humanRequestQuote (the human's words asking for a Project Home tool); the human can add one from Project Home ▸ Tools ▸ Add a tool";

/** Fail-closed check that a human asked for an all-projects macro (or a Project Home tool). */
function verifyAllProjectsRequest(body, { projectHome = false } = {}) {
  const hint = projectHome ? PROJECT_HOME_HINT : HUMAN_HINT;
  const quote = body.humanRequestQuote;
  if (typeof quote !== 'string' || !quote.trim()) {
    return { ok: false, reason: `a macro shown in every project needs humanRequestQuote (a verbatim human request); ${hint}` };
  }
  const origin = body.originClaudeSessionId;
  if (typeof origin !== 'string' || origin.length < 1 || origin.length > 128) {
    return { ok: false, reason: `a macro shown in every project needs originClaudeSessionId (1-128 chars); ${hint}` };
  }
  if (!findHumanPromptContaining(origin, quote)) {
    return { ok: false, reason: `humanRequestQuote was not found in a prompt the human typed in this session; ${hint}` };
  }
  if (!quoteNamesEveryProject(quote) && !(projectHome && quoteNamesProjectHome(quote))) {
    const named = projectHome ? 'Project Home or every/all projects' : 'every/all projects';
    return { ok: false, reason: `humanRequestQuote does not name ${named}; ${hint}` };
  }
  return { ok: true, quote };
}

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
  if (body === null || typeof body !== 'object') {
    sendJson(res, 400, { ok: false, error: 'invalid JSON body' });
    return null;
  }
  return body;
}

function listHandler(onChanged, libOpts) {
  return async (_req, res, query) => {
    const resolved = resolveCwd(query.get('cwd'));
    if (!resolved.ok) {
      sendJson(res, resolved.status, { ok: false, error: resolved.error });
      return;
    }
    const macros = await macroLibrary.listMacros(libOpts);
    const visible = macros.filter(
      (m) => m.projects.includes(resolved.cwd) || m.projects.includes(macroLibrary.ALL_PROJECTS),
    );
    sendJson(res, 200, { ok: true, macros: visible });
  };
}

function saveHandler(onChanged, libOpts) {
  return async (req, res) => {
    const body = await readJsonBody(req, res);
    if (!body) return;
    const resolved = resolveCwd(body.cwd);
    if (!resolved.ok) {
      sendJson(res, resolved.status, { ok: false, error: resolved.error });
      return;
    }
    if (typeof body.id === 'string' && body.id.startsWith('builtin-')) {
      sendJson(res, 400, { ok: false, error: 'built-in macros cannot be edited through this route' });
      return;
    }
    const p = body.projects;
    if (p !== undefined && !(Array.isArray(p) && p.length === 1 && p[0] === macroLibrary.ALL_PROJECTS)) {
      sendJson(res, 400, { ok: false, error: 'projects: only ["*"] is accepted; omit it to use the current project' });
      return;
    }
    const wantsAll = p !== undefined;
    let input;
    try {
      input = macroLibrary.MacroSaveSchema.parse({
        id: body.id,
        label: body.label,
        agentName: body.agentName,
        tag: body.tag,
        prompt: body.prompt,
        inputs: body.inputs,
        surface: body.surface,
      });
    } catch (e) {
      sendJson(res, 400, { ok: false, error: e?.issues?.[0]?.message ?? e?.message ?? 'invalid payload' });
      return;
    }
    let existing;
    if (input.id) {
      const macros = await macroLibrary.listMacros(libOpts);
      existing = macros.find((m) => m.id === input.id);
      if (!existing) {
        sendJson(res, 400, { ok: false, error: `macro not found: ${input.id}` });
        return;
      }
      if (!macroLibrary.macroVisibleIn(existing, resolved.cwd)) {
        sendJson(res, 400, { ok: false, error: `macro ${input.id} is not visible to ${resolved.cwd}` });
        return;
      }
    }
    const resultSurface = input.surface ?? existing?.surface ?? 'sessions';
    const projectHome = resultSurface === 'project-home';
    const allProjects = Boolean(existing?.projects.includes(macroLibrary.ALL_PROJECTS)) || wantsAll || projectHome;
    let quote = null;
    if (allProjects) {
      const v = verifyAllProjectsRequest(body, { projectHome });
      if (!v.ok) {
        sendJson(res, 400, { ok: false, error: v.reason });
        return;
      }
      quote = v.quote;
    }
    if (!input.id) {
      input = {
        ...input,
        projects: wantsAll || projectHome ? [macroLibrary.ALL_PROJECTS] : [resolved.cwd],
        surface: input.surface ?? 'sessions',
      };
    } else if (wantsAll || projectHome) {
      input = { ...input, projects: [macroLibrary.ALL_PROJECTS] };
    }
    let macro;
    try {
      macro = await macroLibrary.saveMacro(input, libOpts);
    } catch (e) {
      sendJson(res, 400, { ok: false, error: e?.message ?? 'save failed' });
      return;
    }
    const origin = body.originClaudeSessionId;
    appendAuditEvent('admin_macro_save', {
      route: '/admin/macros/save',
      cwd: resolved.cwd,
      macroId: macro.id,
      projects: macro.projects,
      surface: macro.surface,
      created: !input.id,
      humanRequestQuote: quote,
      originClaudeSessionId: typeof origin === 'string' && origin.length >= 1 && origin.length <= 128 ? origin : null,
    });
    if (onChanged) onChanged();
    sendJson(res, 200, { ok: true, macro });
  };
}

function deleteHandler(onChanged, libOpts) {
  return async (req, res) => {
    const body = await readJsonBody(req, res);
    if (!body) return;
    const resolved = resolveCwd(body.cwd);
    if (!resolved.ok) {
      sendJson(res, resolved.status, { ok: false, error: resolved.error });
      return;
    }
    if (typeof body.id !== 'string' || !body.id) {
      sendJson(res, 400, { ok: false, error: 'id is required' });
      return;
    }
    let result;
    try {
      result = await macroLibrary.removeMacroFromProject({ id: body.id, cwd: resolved.cwd }, libOpts);
    } catch (e) {
      sendJson(res, 400, { ok: false, error: e?.issues?.[0]?.message ?? e?.message ?? 'delete failed' });
      return;
    }
    if (!result.ok) {
      sendJson(res, 400, result);
      return;
    }
    const origin = body.originClaudeSessionId;
    appendAuditEvent('admin_macro_delete', {
      route: '/admin/macros/delete',
      cwd: resolved.cwd,
      deleted: result.deleted,
      macro: result.macro,
      originClaudeSessionId: typeof origin === 'string' && origin.length >= 1 && origin.length <= 128 ? origin : null,
    });
    if (onChanged) onChanged();
    sendJson(res, 200, result);
  };
}

function registerAdminRoute(adminHttp, { onChanged } = {}, opts = {}) {
  const libOpts = opts.filePath ? { filePath: opts.filePath } : undefined;
  adminHttp.registerRoute('GET', '/admin/macros', listHandler(onChanged, libOpts));
  adminHttp.registerRoute('POST', '/admin/macros/save', saveHandler(onChanged, libOpts));
  adminHttp.registerRoute('POST', '/admin/macros/delete', deleteHandler(onChanged, libOpts));
}

module.exports = {
  registerAdminRoute,
  quoteNamesEveryProject,
  quoteNamesProjectHome,
};

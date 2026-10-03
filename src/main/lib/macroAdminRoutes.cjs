/**
 * macroAdminRoutes.cjs — loopback admin HTTP routes so an agent session (via
 * the scheduler MCP, next PRD) can list and create/update a HOT KEYS macro
 * for its own project, through the existing macroLibrary.cjs store:
 *   GET  /admin/macros?cwd=…                          -> { ok, macros }
 *   POST /admin/macros/save  {cwd, id?, label, agentName, tag, prompt}
 *
 * cwd resolution matches projectHomeAdminRoutes.cjs's resolveCwd exactly
 * (reused, not copied). A create always stores `projects: [resolvedCwd]`,
 * `surface: 'sessions'`; an update is refused (400) if the resolved cwd is
 * not already in the macro's `projects` (no cross-project hijack), if `id`
 * starts with `builtin-`, or if `id` is not found. Field validation reuses
 * macroLibrary's `MacroSaveSchema`.
 *
 * A successful save calls `onChanged()` exactly once so the Sessions HOT
 * KEYS strip updates live, matching the IPC handlers in index.cjs.
 */
'use strict';

const { readBody, sendJson } = require('./localAdminHttp.cjs');
const { resolveCwd } = require('./projectHomeAdminRoutes.cjs');
const macroLibrary = require('./macroLibrary.cjs');

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
    let raw;
    try {
      raw = await readBody(req);
    } catch (e) {
      sendJson(res, 400, { ok: false, error: `request body rejected: ${e?.message ?? 'unreadable'}` });
      return;
    }
    let body;
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      sendJson(res, 400, { ok: false, error: 'invalid JSON body' });
      return;
    }
    const resolved = resolveCwd(body.cwd);
    if (!resolved.ok) {
      sendJson(res, resolved.status, { ok: false, error: resolved.error });
      return;
    }
    if (typeof body.id === 'string' && body.id.startsWith('builtin-')) {
      sendJson(res, 400, { ok: false, error: 'built-in macros cannot be edited through this route' });
      return;
    }
    let input;
    try {
      input = macroLibrary.MacroSaveSchema.parse({
        id: body.id,
        label: body.label,
        agentName: body.agentName,
        tag: body.tag,
        prompt: body.prompt,
      });
    } catch (e) {
      sendJson(res, 400, { ok: false, error: e?.issues?.[0]?.message ?? e?.message ?? 'invalid payload' });
      return;
    }
    if (input.id) {
      const macros = await macroLibrary.listMacros(libOpts);
      const existing = macros.find((m) => m.id === input.id);
      if (!existing) {
        sendJson(res, 400, { ok: false, error: `macro not found: ${input.id}` });
        return;
      }
      if (!existing.projects.includes(resolved.cwd)) {
        sendJson(res, 400, { ok: false, error: `macro ${input.id} is not visible to ${resolved.cwd}` });
        return;
      }
    } else {
      input = { ...input, projects: [resolved.cwd], surface: 'sessions' };
    }
    let macro;
    try {
      macro = await macroLibrary.saveMacro(input, libOpts);
    } catch (e) {
      sendJson(res, 400, { ok: false, error: e?.message ?? 'save failed' });
      return;
    }
    if (onChanged) onChanged();
    sendJson(res, 200, { ok: true, macro });
  };
}

function registerAdminRoute(adminHttp, { onChanged } = {}, opts = {}) {
  const libOpts = opts.filePath ? { filePath: opts.filePath } : undefined;
  adminHttp.registerRoute('GET', '/admin/macros', listHandler(onChanged, libOpts));
  adminHttp.registerRoute('POST', '/admin/macros/save', saveHandler(onChanged, libOpts));
}

module.exports = {
  registerAdminRoute,
};

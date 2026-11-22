'use strict';

/**
 * toolRiskIpc.cjs — the one main-process API for tool-risk marks:
 *
 *   toolRisk:read  ({ scope, cwd? })                       -> { ok, path, exists, marks, interactive, error? }
 *   toolRisk:write ({ scope, cwd?, marks, interactive? })  -> { ok, path, error? }
 *
 * scope 'user'    = System  ~/.claude/tool-risk.json
 * scope 'project' = Project <cwd>/.claude/tool-risk.json
 *
 * Every read/validate/write goes through toolRiskMarks.cjs (readMarksLayer /
 * validateMarksFile / writeMarksLayer). `interactive` is a Project-only opt-in:
 * turning it on installs guard-tool-risk into <cwd>/.claude/settings.json's
 * PreToolUse hooks via its stable shim (delegationReadiness.cjs installGuard —
 * the same merge/repair path the sanctioned guards use, with a local def, NOT a
 * GUARD_DEFS entry, so the readiness banner never auto-installs it); turning it
 * off removes exactly that hook.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  systemMarksPath,
  projectMarksPath,
  readMarksLayer,
  validateMarksFile,
  writeMarksLayer,
} = require('./toolRiskMarks.cjs');

const TOOL_RISK_GUARD_MATCHER = 'Bash|Write|Edit|NotebookEdit|mcp__.*';
const TOOL_RISK_GUARD_SCRIPT = path.resolve(__dirname, '..', '..', '..', '..', 'scripts', 'hooks', 'guard-tool-risk.cjs');
const TOOL_RISK_GUARD_DEF = Object.freeze({
  id: 'tool-risk-guard',
  label: 'Tool-risk guard hook installed',
  guardName: 'guard-tool-risk',
  scriptBasename: 'guard-tool-risk.cjs',
  script: TOOL_RISK_GUARD_SCRIPT,
  matcher: TOOL_RISK_GUARD_MATCHER,
  fixActionId: null,
  nudge: false,
});

function errMsg(e) {
  return e && e.message ? e.message : String(e);
}

/** @returns {{ok:true, path:string} | {ok:false, path:string|null, error:string}} */
function layerPath({ scope, cwd }, homeDir) {
  if (scope === 'user') return { ok: true, path: systemMarksPath(homeDir) };
  if (scope === 'project') {
    if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) {
      return { ok: false, path: null, error: 'scope "project" needs an absolute cwd' };
    }
    return { ok: true, path: projectMarksPath(cwd) };
  }
  return { ok: false, path: null, error: `unknown scope ${JSON.stringify(scope)}` };
}

async function readToolRisk(payload, { homeDir = os.homedir() } = {}) {
  const p = layerPath(payload || {}, homeDir);
  if (!p.ok) return { ok: false, path: p.path, exists: false, marks: {}, interactive: false, error: p.error };
  const r = readMarksLayer(p.path);
  if (!r.ok) return { ok: false, path: p.path, exists: r.exists === true, marks: {}, interactive: false, error: r.error };
  return { ok: true, path: p.path, exists: r.exists, marks: r.marks, interactive: r.interactive };
}

/** Remove every guard-tool-risk hook from <cwd>/.claude/settings.json; drop an emptied entry. */
async function removeToolRiskGuard({ cwd }) {
  const { readJsonOrSync } = require('../util/atomicFs.cjs');
  const { writeJson, addAllowedRoot } = require('../../config.cjs');
  const settingsPath = path.join(cwd, '.claude', 'settings.json');
  if (!fs.existsSync(settingsPath)) return { ok: true, action: 'not-installed', settingsPath };
  const settings = readJsonOrSync(settingsPath, undefined);
  if (settings === undefined || !settings || typeof settings !== 'object' || Array.isArray(settings)) {
    return { ok: false, action: 'error', error: `${settingsPath} is not valid JSON — fix it by hand before removing the guard` };
  }
  const hooks = (settings.hooks && typeof settings.hooks === 'object') ? settings.hooks : null;
  if (!hooks || !Array.isArray(hooks.PreToolUse)) return { ok: true, action: 'not-installed', settingsPath };

  const isOurs = (h) => typeof h?.command === 'string' && h.command.includes(TOOL_RISK_GUARD_DEF.guardName);
  let removed = false;
  const preToolUse = [];
  for (const entry of hooks.PreToolUse) {
    if (!Array.isArray(entry?.hooks) || !entry.hooks.some(isOurs)) { preToolUse.push(entry); continue; }
    removed = true;
    const kept = entry.hooks.filter((h) => !isOurs(h));
    if (kept.length > 0) preToolUse.push({ ...entry, hooks: kept });
  }
  if (!removed) return { ok: true, action: 'not-installed', settingsPath };

  const nextHooks = { ...hooks };
  if (preToolUse.length > 0) nextHooks.PreToolUse = preToolUse;
  else delete nextHooks.PreToolUse;
  const next = { ...settings };
  if (Object.keys(nextHooks).length > 0) next.hooks = nextHooks;
  else delete next.hooks;
  addAllowedRoot(cwd);
  await writeJson(settingsPath, next);
  return { ok: true, action: 'removed', settingsPath };
}

async function installToolRiskGuard({ cwd, homeDir }) {
  const { installGuard } = require('../epic/delegationReadiness.cjs');
  return installGuard(TOOL_RISK_GUARD_DEF, { cwd, homeDir });
}

async function writeToolRisk(payload, { homeDir = os.homedir() } = {}) {
  const { scope, cwd, marks, interactive } = payload || {};
  const p = layerPath({ scope, cwd }, homeDir);
  if (!p.ok) return { ok: false, path: p.path, error: p.error };
  if (scope === 'user' && interactive !== undefined) {
    return { ok: false, path: p.path, error: '"interactive" is a Project-only opt-in; it cannot be set on the System (user) layer' };
  }

  // Omitted `interactive` on a Project write keeps the file's current value.
  let nextInteractive = interactive;
  if (scope === 'project' && nextInteractive === undefined) {
    const prev = readMarksLayer(p.path);
    if (prev.ok && prev.exists && prev.interactive) nextInteractive = true;
  }
  const obj = { version: 1, marks };
  if (nextInteractive !== undefined) obj.interactive = nextInteractive;

  const v = validateMarksFile(obj);
  if (!v.ok) return { ok: false, path: p.path, error: v.error };

  try {
    const w = await writeMarksLayer(p.path, obj);
    if (!w.ok) return { ok: false, path: p.path, error: w.error };
  } catch (e) {
    return { ok: false, path: p.path, error: errMsg(e) };
  }

  if (scope === 'project' && interactive !== undefined) {
    let hook;
    try {
      hook = interactive
        ? await installToolRiskGuard({ cwd, homeDir })
        : await removeToolRiskGuard({ cwd });
    } catch (e) {
      hook = { ok: false, error: errMsg(e) };
    }
    if (!hook.ok) return { ok: false, path: p.path, error: `marks saved, but the guard hook could not be ${interactive ? 'installed' : 'removed'}: ${hook.error}` };
  }
  return { ok: true, path: p.path };
}

/**
 * @param {import('electron').IpcMain} ipcMain
 * @param {{ schemas: any, validated: Function, validatePath?: (p:string)=>string, homeDir?: string,
 *           onChanged?: (info:{path:string}) => void }} deps
 */
function registerToolRiskIpc(ipcMain, deps) {
  const { schemas, validated, validatePath, onChanged } = deps;
  const opts = () => ({ homeDir: deps.homeDir || os.homedir() });
  ipcMain.handle('toolRisk:read', validated(schemas.toolRiskRead, async (p) => {
    if (p.cwd && validatePath) validatePath(p.cwd);
    return readToolRisk(p, opts());
  }));
  ipcMain.handle('toolRisk:write', validated(schemas.toolRiskWrite, async (p) => {
    if (p.cwd && validatePath) validatePath(p.cwd);
    const result = await writeToolRisk(p, opts());
    if (result.ok && onChanged) onChanged({ path: result.path });
    return result;
  }));
}

module.exports = {
  TOOL_RISK_GUARD_MATCHER,
  TOOL_RISK_GUARD_DEF,
  readToolRisk,
  writeToolRisk,
  removeToolRiskGuard,
  registerToolRiskIpc,
};

'use strict';

/**
 * packsIpc.cjs — `packs:list`: the shipped context-pack catalog as DISPLAY data
 * for the New Session picker. Returns only { id, label, description, requires,
 * hasLaws } per pack — never the pack dir, plugin name, or laws text, which stay
 * main-side (spawn args are built in packSpawnArgs.cjs). Catalog load errors are
 * dropped here because they carry absolute paths.
 *
 * `packs:terminal-args` — the pack part of an Epic Terminal pane's `claude` line
 * ({ cwd, claudeSessionId } → { ok: true, args }), so Terminal loads the same
 * packs as the Epic's chat turns. Main composes it because only main knows pack
 * dirs. Never fails: agent-CLI Epics, Epics without packs, and lookup errors all
 * return { ok: true, args: [] }.
 */

function toDisplay(p) {
  return {
    id: p.id,
    label: p.label,
    description: p.description,
    requires: p.requires && typeof p.requires === 'object' ? { ...p.requires } : {},
    hasLaws: typeof p.laws === 'string' && p.laws.length > 0,
  };
}

/** True for an Epic run by a non-Claude agent CLI (absent agentCli = Claude Code). */
function isAgentCliEpic(epic) {
  const cli = epic && typeof epic.agentCli === 'string' ? epic.agentCli.trim() : '';
  return cli !== '' && cli !== 'claude';
}

/**
 * @param {{ cwd?: unknown, claudeSessionId?: unknown }} payload
 * @param {{ findEpic?: Function, composePackSpawnArgs?: Function }} [deps]
 * @returns {{ ok: true, args: string[] }}
 */
function buildTerminalPackArgs(payload, deps = {}) {
  try {
    const cwd = payload && typeof payload.cwd === 'string' ? payload.cwd : '';
    const claudeSessionId = payload && typeof payload.claudeSessionId === 'string' ? payload.claudeSessionId : '';
    if (!cwd || !claudeSessionId) return { ok: true, args: [] };
    const findEpic = deps.findEpic || require('../claude/agentModelResolve.cjs').findEpicByClaudeSessionId;
    const compose = deps.composePackSpawnArgs || require('./packSpawnArgs.cjs').composePackSpawnArgs;
    const epic = findEpic(cwd, claudeSessionId);
    if (!epic || isAgentCliEpic(epic)) return { ok: true, args: [] };
    if (!Array.isArray(epic.packs) || epic.packs.length === 0) return { ok: true, args: [] };
    const { pluginDirArgs, laws } = compose({ packIds: epic.packs });
    const args = Array.isArray(pluginDirArgs) ? pluginDirArgs.map(String) : [];
    if (typeof laws === 'string' && laws.length > 0) args.push('--append-system-prompt', laws);
    return { ok: true, args };
  } catch {
    return { ok: true, args: [] };
  }
}

/**
 * @param {{ ipcMain?: any, listPacks?: () => { packs: any[] }, findEpic?: Function, composePackSpawnArgs?: Function }} [opts]
 */
function registerPacksHandlers(opts = {}) {
  const ipcMain = opts.ipcMain || require('electron').ipcMain;
  const listPacks = opts.listPacks || require('./packCatalog.cjs').listPacks;
  ipcMain.handle('packs:list', async () => {
    try {
      const res = listPacks();
      const packs = (res && Array.isArray(res.packs) ? res.packs : []).map(toDisplay);
      return { ok: true, packs };
    } catch (e) {
      return { ok: false, error: e && e.message ? e.message : String(e) };
    }
  });
  ipcMain.handle('packs:terminal-args', async (_e, payload) =>
    buildTerminalPackArgs(payload, { findEpic: opts.findEpic, composePackSpawnArgs: opts.composePackSpawnArgs }));
}

module.exports = { registerPacksHandlers, buildTerminalPackArgs };

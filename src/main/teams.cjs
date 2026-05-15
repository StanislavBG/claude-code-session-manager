/**
 * Teams enumerator — surfaces ~/.claude/teams/<name>/ to the renderer.
 *
 * Each team is a directory containing:
 *   - config.json: { name, description?, members: [{ name, agentType, model, cwd?, ... }], ... }
 *   - inboxes/<thread>.json: one file per pending message thread (depth = file count)
 *
 * We treat teams as feature-flagged: enabled when env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS === "1"
 * is set in merged Claude settings. The renderer does its own check; this
 * handler always returns the on-disk roster so the UI can keep recovering
 * gracefully even if settings are unparseable.
 *
 * All reads route through config.cjs (validatePath + atomic semantics).
 * Complexity: O(T·M) where T = teams and M = members; both are small (< 20).
 */

const { ipcMain } = require('electron');
const os = require('node:os');
const path = require('node:path');
const configMgr = require('./config.cjs');

const TEAMS_ROOT = path.join(os.homedir(), '.claude', 'teams');

/**
 * Enumerate teams. Returns { teams: TeamInfo[] }.
 * Failures per-team (unreadable config.json, missing inbox dir) are swallowed —
 * the team is included with whatever data we could recover. The renderer
 * decides how to render incomplete entries.
 */
async function listTeams() {
  let dir;
  try {
    dir = await configMgr.listDir(TEAMS_ROOT, { dirsOnly: true });
  } catch {
    // listDir throws when path is outside allowed boundaries — should not
    // happen for ~/.claude/teams, but guard anyway.
    return { teams: [] };
  }
  if (!dir.ok || dir.entries.length === 0) return { teams: [] };

  const teams = [];
  for (const entry of dir.entries) {
    const teamName = entry.name;
    const configPath = path.join(entry.path, 'config.json');
    const inboxDir = path.join(entry.path, 'inboxes');

    let config = null;
    try {
      const r = await configMgr.readJson(configPath);
      if (r.exists && !r.parseError) config = r.data;
    } catch { /* unreadable — leave config null */ }

    let inboxDepth = 0;
    try {
      const inbox = await configMgr.listDir(inboxDir, { filesOnly: true });
      if (inbox.ok) {
        inboxDepth = inbox.entries.filter((f) => f.name.endsWith('.json')).length;
      }
    } catch { /* no inbox dir is fine */ }

    const members = Array.isArray(config?.members)
      ? config.members.map((m) => ({
          name: typeof m?.name === 'string' ? m.name : 'unnamed',
          agentType: typeof m?.agentType === 'string' ? m.agentType : null,
          model: typeof m?.model === 'string' ? m.model : null,
        }))
      : [];

    teams.push({
      name: teamName,
      configPath,
      description: typeof config?.description === 'string' ? config.description : null,
      leadAgentId: typeof config?.leadAgentId === 'string' ? config.leadAgentId : null,
      members,
      memberCount: members.length,
      inboxDepth,
    });
  }
  return { teams };
}

function registerTeamsHandlers() {
  ipcMain.handle('teams:list', () => listTeams());
}

module.exports = {
  registerTeamsHandlers,
  // exported for direct use / tests
  listTeams,
};

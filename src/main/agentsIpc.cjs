'use strict';

/**
 * agentsIpc.cjs — registers the `agents:*` IPC handlers (Agent Library CRUD + persona/model/effort
 * resolvers). Moved verbatim out of index.cjs; handler bodies and zod wrappers are unchanged.
 */

const { schemas, validated } = require('./ipcSchemas.cjs');
const agentLibrary = require('./agentLibrary.cjs');
const agentModelResolve = require('./lib/agentModelResolve.cjs');
const agentEffortResolve = require('./lib/agentEffortResolve.cjs');
const { resolveEffectiveModelInfo } = require('./lib/effectiveModelInfo.cjs');
const { sendIfAlive } = require('./lib/sendToRenderer.cjs');

/**
 * @param {{ ipcMain: any, getWindow: () => any }} opts
 */
function registerAgentsHandlers({ ipcMain, getWindow }) {
  // Agent Library nav page (Home face only): global `~/.claude/agents/*.md`
  // personas plus, per currently-open project tab, whether that project
  // overlays the same agent name at `<cwd>/.claude/agents/<name>.md`. Read-only.
  ipcMain.handle('agents:list-personas', () => agentLibrary.listPersonas());
  // Agent Library CRUD — global personas only (`~/.claude/agents/*.md`); a
  // project's local overlay can only be removed here (removeOverride), never
  // created, since Agent Library is a Home-face, machine-wide surface with no
  // per-tab cwd context of its own. Each mutation broadcasts `agents:changed`
  // so Agent Library and Tag Library — two independently-mounted dockview
  // panels, each with its own component-local `listPersonas()` snapshot —
  // both refresh off the one file on disk instead of one panel going stale
  // after the other edits the agent<->tag relationship.
  function broadcastAgentsChanged() {
    sendIfAlive(getWindow(), 'agents:changed', {});
  }
  ipcMain.handle('agents:save-persona', validated(schemas.agentsSavePersona, async (payload) => {
    const result = await agentLibrary.savePersona(payload);
    broadcastAgentsChanged();
    return result;
  }));
  ipcMain.handle('agents:delete-persona', async (_e, payload) => {
    const result = await agentLibrary.deletePersona(payload);
    broadcastAgentsChanged();
    return result;
  });
  ipcMain.handle('agents:remove-override', async (_e, payload) => {
    const result = await agentLibrary.removeOverride(payload);
    broadcastAgentsChanged();
    return result;
  });
  // New Epic AIM composer (epicIntake.ts's `agentBody`/`agentPath`): unlike
  // list-personas above (global dir only), this honors the project-overlay-
  // then-global precedence so an Epic's opening prompt carries the persona
  // body that actually applies to its cwd. Read-only.
  ipcMain.handle('agents:get-persona-body', validated(schemas.agentsGetPersonaBody, (payload) =>
    agentLibrary.getPersonaBody(payload)));

  // "What will this Epic's launch actually use for --model?" — the SAME
  // resolver chatRunner.cjs's Chat-view launch calls in-process
  // (agentModelResolve.cjs's resolveEpicModel), reached here so Terminal's
  // launch (EpicTerminalPane.tsx, a renderer module with no fs access) agrees
  // with Chat by calling the identical function rather than a second one that
  // is merely supposed to. Never throws (resolveEpicModel's own contract).
  ipcMain.handle('agents:resolve-epic-model', validated(schemas.agentsResolveEpicModel, (payload) =>
    agentModelResolve.resolveEpicModel(payload)));
  // Effort twin of the above (agentEffortResolve.cjs): Terminal appends
  // `--effort <level>` only when `effort` is non-null. Never throws.
  ipcMain.handle('agents:resolve-epic-effort', validated(schemas.agentsResolveEpicEffort, (payload) =>
    agentEffortResolve.resolveEpicEffort(payload)));

  // "What will this Epic actually run as?" (PRD: effective-model-resolver) —
  // persona alias + evidence-based concrete model id + provenance, for a given
  // (cwd, agentType). Read-only observer; never affects what a launch resolves.
  ipcMain.handle('agents:resolve-model-info', validated(schemas.agentsResolveModelInfo, (payload) =>
    resolveEffectiveModelInfo(payload)));
}

module.exports = { registerAgentsHandlers };

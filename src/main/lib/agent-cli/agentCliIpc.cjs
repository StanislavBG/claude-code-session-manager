'use strict';

/**
 * agentCliIpc.cjs — the `agentCli:*` IPC handlers the renderer needs for
 * non-Claude agent-CLI sessions:
 *   agentCli:detect            — which CLIs are installed (New Session picker)
 *   agentCli:terminal-command  — the exact shell line the Epic Terminal pane
 *                                types to launch / resume a non-Claude session
 *
 * Main owns both because the registry and adapters are CommonJS + fs-bound.
 * Desktop-only: these channels are NOT in the web-remote command allowlist.
 * Every dependency is injectable (`deps`) so tests spawn and read nothing.
 */

const { z } = require('zod');
const { validated } = require('../../ipcSchemas.cjs');
const registry = require('./agentCliRegistry.cjs');
const { readNativeSession } = require('./agentCliSessionStore.cjs');
const { findEpicByClaudeSessionId } = require('../claude/agentModelResolve.cjs');

const detectSchema = z.object({ refresh: z.boolean().optional() }).strict();
const terminalCommandSchema = z.object({
  cwd: z.string().min(1).max(4096),
  claudeSessionId: z.string().min(1).max(200),
}).strict();

/** Single-quote a value for safe shell interpolation — same rule as renderer/lib/presets.ts shellQuote. */
function shellQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

function withDefaults(deps) {
  const d = deps || {};
  return {
    readActiveIndex: d.readActiveIndex, // undefined → findEpicByClaudeSessionId's own default
    resolveAgentCliBin: d.resolveAgentCliBin || registry.resolveAgentCliBin,
    readNativeSession: d.readNativeSession || readNativeSession,
    adapterFor: d.adapterFor || registry.adapterFor,
    detectAgentClis: d.detectAgentClis || registry.detectAgentClis,
  };
}

/**
 * Builds the Terminal launch/resume line for a non-Claude Epic.
 * @returns {Promise<{ok:true, command:string} | {ok:false, message:string}>} never rejects
 */
async function buildTerminalCommand({ cwd, claudeSessionId }, deps) {
  const d = withDefaults(deps);
  let epic = null;
  try {
    epic = findEpicByClaudeSessionId(cwd, claudeSessionId, d.readActiveIndex ? { readActiveIndex: d.readActiveIndex } : {});
  } catch (e) {
    return { ok: false, message: `Could not read this project's sessions: ${e && e.message ? e.message : String(e)}` };
  }
  if (!epic) return { ok: false, message: 'No session with that id in this project.' };

  const cli = epic.agentCli;
  const entry = typeof cli === 'string' && Object.prototype.hasOwnProperty.call(registry.AGENT_CLI_CATALOG, cli)
    ? registry.AGENT_CLI_CATALOG[cli]
    : null;
  if (!entry) return { ok: false, message: 'This session is not a non-Claude agent-CLI session.' };

  let adapter = null;
  try { adapter = d.adapterFor(cli); } catch { adapter = null; }
  if (!adapter || typeof adapter.interactiveArgs !== 'function') {
    return { ok: false, message: `${entry.label} is not supported yet.` };
  }

  let binPath = null;
  try { binPath = d.resolveAgentCliBin(cli); } catch { binPath = null; }
  if (!binPath) {
    const hint = entry.install ? `Install it with: ${entry.install}` : `See ${entry.docs}`;
    return { ok: false, message: `${entry.label} is not installed. ${hint}` };
  }

  let nativeSessionId = null;
  try {
    const rec = d.readNativeSession(claudeSessionId);
    if (rec && typeof rec.nativeSessionId === 'string' && rec.nativeSessionId
      && (rec.cli === undefined || rec.cli === cli)) {
      nativeSessionId = rec.nativeSessionId;
    }
  } catch { nativeSessionId = null; } // invalid id / unreadable sidecar → fresh launch

  const model = typeof epic.agentCliModel === 'string' && epic.agentCliModel.trim() ? epic.agentCliModel.trim() : undefined;
  let args;
  try {
    args = adapter.interactiveArgs({ nativeSessionId, claudeSessionId, model });
  } catch (e) {
    return { ok: false, message: `Could not build the ${entry.label} command: ${e && e.message ? e.message : String(e)}` };
  }
  const command = [binPath, ...(Array.isArray(args) ? args : [])].map(shellQuote).join(' ');
  return { ok: true, command };
}

/**
 * @param {{ ipcMain?: any, deps?: object }} [opts]
 */
function registerAgentCliHandlers(opts = {}) {
  const ipcMain = opts.ipcMain || require('electron').ipcMain;
  const deps = opts.deps;
  const d = withDefaults(deps);
  ipcMain.handle('agentCli:detect', validated(detectSchema, (payload) =>
    d.detectAgentClis({ refresh: !!payload.refresh })));
  ipcMain.handle('agentCli:terminal-command', validated(terminalCommandSchema, (payload) =>
    buildTerminalCommand(payload, deps)));
}

module.exports = { registerAgentCliHandlers, buildTerminalCommand, shellQuote };

'use strict';
// agentCliTurn.cjs — plans ONE Chat turn of a non-Claude agent-CLI Epic
// (codex, gemini, antigravity, cursor, opencode) for chatRunner.cjs's
// executeRun: which binary to spawn, its argv + stdin (from the adapter's
// headlessSpawn), the auth env it may inherit, a fresh stream parser and the
// Claude-compatible transcript writer. Spawns nothing; every collaborator is
// injectable via `deps` so tests touch no PATH and no disk.
//
// The model is epic.agentCliModel or nothing — persona --model resolution is
// Claude-only and is never forwarded to another CLI.

const registry = require('./agentCliRegistry.cjs');
const sessionStore = require('./agentCliSessionStore.cjs');

const NOOP_TRANSCRIPT = Object.freeze({ userPrompt() {}, event() {}, close() {} });

function withDefaults(deps) {
  const d = deps || {};
  return {
    adapterFor: d.adapterFor || registry.adapterFor,
    resolveAgentCliBin: d.resolveAgentCliBin || registry.resolveAgentCliBin,
    catalog: d.catalog || registry.AGENT_CLI_CATALOG,
    readNativeSession: d.readNativeSession || sessionStore.readNativeSession,
    createTranscriptWriter: d.createTranscriptWriter || sessionStore.createTranscriptWriter,
    env: d.env || process.env,
  };
}

/** Catalog authEnv keys that are set (non-empty) in env — nothing else. */
function pickAuthEnv(entry, env) {
  const out = {};
  const keys = entry && Array.isArray(entry.authEnv) ? entry.authEnv : [];
  for (const k of keys) {
    const v = env[k];
    if (typeof v === 'string' && v !== '') out[k] = v;
  }
  return out;
}

/**
 * @param {{ epic: object, claudeSessionId: string, cwd: string, prompt: string, deps?: object }} opts
 * @returns {{ ok: true, command: string, args: string[], stdin: string, envExtra: Record<string,string>,
 *   parser: { push(line: string): object[], end(o: { exitCode: number|null }): object[] },
 *   transcript: { userPrompt(t: string): void, event(e: object): void, close(): void }, cli: string }
 *   | { ok: false, code: string, message: string }}
 */
function planAgentCliTurn({ epic, claudeSessionId, cwd, prompt, deps } = {}) {
  const d = withDefaults(deps);
  const cli = epic && typeof epic.agentCli === 'string' ? epic.agentCli : '';
  const adapter = cli ? d.adapterFor(cli) : null;
  const entry = cli && Object.prototype.hasOwnProperty.call(d.catalog, cli) ? d.catalog[cli] : null;
  if (!adapter || !entry) {
    return { ok: false, code: 'agent_cli_unknown', message: `Unknown agent CLI: ${JSON.stringify(cli || null)}` };
  }

  let command = null;
  try { command = d.resolveAgentCliBin(cli); } catch { command = null; }
  if (!command) {
    return {
      ok: false,
      code: 'agent_cli_missing',
      message: `${entry.label} CLI not found on PATH. Install: ${entry.install || entry.docs}`,
    };
  }

  let nativeSessionId;
  try {
    const rec = d.readNativeSession(claudeSessionId);
    if (rec && typeof rec.nativeSessionId === 'string' && rec.nativeSessionId && (!rec.cli || rec.cli === cli)) {
      nativeSessionId = rec.nativeSessionId;
    }
  } catch { nativeSessionId = undefined; }

  const model = typeof epic.agentCliModel === 'string' && epic.agentCliModel.trim()
    ? epic.agentCliModel.trim()
    : undefined;
  const spawnPlan = adapter.headlessSpawn({ prompt, nativeSessionId, model }) || {};
  if (spawnPlan.error) {
    return { ok: false, code: 'agent_cli_prompt', message: String(spawnPlan.error) };
  }

  let transcript = NOOP_TRANSCRIPT;
  try {
    transcript = d.createTranscriptWriter({ claudeSessionId, cwd, cli }) || NOOP_TRANSCRIPT;
  } catch { transcript = NOOP_TRANSCRIPT; } // non-UUID session id: no transcript, turn still runs

  return {
    ok: true,
    command,
    args: Array.isArray(spawnPlan.args) ? spawnPlan.args : [],
    stdin: typeof spawnPlan.stdin === 'string' ? spawnPlan.stdin : '',
    envExtra: pickAuthEnv(entry, d.env),
    parser: adapter.createParser(),
    transcript,
    cli,
  };
}

module.exports = { planAgentCliTurn };

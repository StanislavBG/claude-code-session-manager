/**
 * Point-of-use repair for the two delegation preconditions the boot seeders
 * give up on after MAX_ATTEMPTS: the session-manager-dev plugin and the
 * session-manager-scheduler MCP registration. Called by the
 * app:delegation-readiness handler when either check is failing. Each check id
 * is attempted at most once per app process, regardless of the seed marker.
 * Never throws; failures go to opsErrorLog (scope 'delegationSelfHeal').
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const attempted = new Set();

function readSettings(homeDir) {
  try { return JSON.parse(fs.readFileSync(path.join(homeDir, '.claude', 'settings.json'), 'utf8')); } catch { return null; }
}

function defaultDeps(homeDir) {
  const dev = require('../../seedDevPlugin.cjs');
  const mcp = require('../../seedSchedulerMcp.cjs');
  return {
    install: (opts) => require('../../pluginInstall.cjs').install(opts),
    mcpRepair: async () => {
      await mcp.runClaudeMcpRemove(); // best-effort: add refuses when a stale entry exists
      return mcp.runClaudeMcpAdd(mcp.serverScriptPath());
    },
    writeMarker: (id, state) => (id === 'dev-plugin' ? dev.writeMarker(state, homeDir) : mcp.writeMarker(state)),
    readSettings,
    log: (entry) => require('../telemetry/opsErrorLog.cjs').appendError(entry),
    awaitBootSeeding: async () => {},
  };
}

/**
 * @param {{ checks: Array<{id:string, ok:boolean}>, homeDir?: string, deps?: object }} args
 */
async function selfHealDelegation({ checks, homeDir = os.homedir(), deps = {} } = {}) {
  const d = { ...defaultDeps(homeDir), ...deps };
  const failing = new Set((checks || []).filter((c) => c && !c.ok).map((c) => c.id));
  const todo = ['dev-plugin', 'scheduler-mcp'].filter((id) => failing.has(id) && !attempted.has(id));
  if (!todo.length) return { attempted: [] };
  for (const id of todo) attempted.add(id); // claim synchronously: concurrent probes can't double-run
  try { await d.awaitBootSeeding?.(); } catch { /* boot seeding failures are logged elsewhere */ }

  const done = [];
  for (const id of todo) {
    try {
      let r;
      if (id === 'dev-plugin') {
        const enabled = d.readSettings(homeDir)?.enabledPlugins?.['session-manager-dev@session-manager'];
        if (enabled === false) continue; // deliberate disable stays
        r = await d.install({ slug: 'session-manager-dev', marketplace: { add: 'bundled', name: 'session-manager' } });
      } else {
        r = await d.mcpRepair();
      }
      done.push(id);
      if (r?.ok) d.writeMarker(id, { done: true, attempts: 0 });
      else throw new Error(r?.error || `exit ${r?.exitCode}`);
    } catch (err) {
      try {
        d.log({
          cwd: d.cwd,
          scope: 'delegationSelfHeal',
          level: 'error',
          message: `${id} self-heal failed: ${err?.message ?? err}`,
          meta: { check: id },
        });
      } catch { /* logging is best-effort */ }
    }
  }
  return { attempted: done };
}

function _resetForTests() { attempted.clear(); }

module.exports = { selfHealDelegation, _resetForTests };

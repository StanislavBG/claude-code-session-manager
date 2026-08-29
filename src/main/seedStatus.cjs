/**
 * Renderer-facing rollup of first-boot seeder outcomes.
 *
 * Derived purely by reading each seeder's own marker file — never re-runs an
 * install to find out. A missing or unparseable marker means the seeder
 * hasn't run yet (or its file got corrupted), which is indistinguishable
 * from "still pending" and must never surface as an error.
 */

'use strict';

const fs = require('node:fs');

const seedDevPlugin = require('./seedDevPlugin.cjs');
const seedSchedulerMcp = require('./seedSchedulerMcp.cjs');
const seedAgentPersonas = require('./seedAgentPersonas.cjs');

// Each entry's key is the seeder id surfaced to the renderer/IPC contract.
const SEEDERS = {
  'dev-plugin': seedDevPlugin,
  'scheduler-mcp': seedSchedulerMcp,
  'agent-personas': seedAgentPersonas,
};

/** One seeder's marker → 'done' | 'pending' | 'exhausted'. */
function statusFromMarker(mod) {
  try {
    const raw = fs.readFileSync(mod.markerPath(), 'utf8').trim();
    const m = JSON.parse(raw);
    if (m && m.done) return 'done';
    const attempts = Number(m && m.attempts) || 0;
    return attempts >= mod.MAX_ATTEMPTS ? 'exhausted' : 'pending';
  } catch {
    return 'pending'; // absent or unparseable — never surfaced as an error.
  }
}

// The manual fix surfaced by the Plugins banner when a seeder is exhausted.
// `scheduler-mcp`'s command reuses the same server-script path the seeder
// itself resolves (seedSchedulerMcp.serverScriptPath()) — single source of
// truth for that absolute path, never re-derived here.
const FIXES = {
  'dev-plugin': 'Open Plugins → Library and click Install next to "session-manager-dev".',
  'scheduler-mcp': () =>
    `Run in a terminal: claude mcp add ${seedSchedulerMcp.SERVER_NAME} --scope user -- node ${seedSchedulerMcp.serverScriptPath()}`,
  'agent-personas': 'Copy src/seed/agents/architect.md and dev-lead.md into ~/.claude/agents/ (skip any that already exist there).',
};

/** { 'dev-plugin': {status, fix}, 'scheduler-mcp': {status, fix}, 'agent-personas': {status, fix} } */
function getSeedStatus() {
  const out = {};
  for (const [id, mod] of Object.entries(SEEDERS)) {
    const fix = FIXES[id];
    out[id] = { status: statusFromMarker(mod), fix: typeof fix === 'function' ? fix() : fix };
  }
  return out;
}

module.exports = { getSeedStatus };

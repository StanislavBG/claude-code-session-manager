'use strict';

/**
 * projectVideoToolCheck.cjs — says whether a Project Video tool can actually
 * run, with an actionable reason when it cannot.
 *
 * A Project Video tool runs as a headless scheduled job, so:
 *   1. its persona must resolve as a PRD agentType (a file in
 *      <cwd>/.claude/agents/ or ~/.claude/agents/), and
 *   2. when the persona declares a tools list, the job is scoped to it, so
 *      that list must include the SM MCP save tools the run calls.
 *
 * The MCP name rule mirrors scripts/scheduler-mcp-server.cjs jobToolScope
 * (src/main never requires from scripts/; the test pins the agreement).
 * Plain Node, no Electron imports. Never throws.
 */

const { buildPersonaToolScope } = require('../claude/personaToolScope.cjs');

const MCP_SERVER = 'session-manager-scheduler';
const PROJECT_VIDEO_WRITE_ID = `mcp__${MCP_SERVER}__project_video_write`;
const PROJECT_VIDEO_REVIEW_WRITE_ID = `mcp__${MCP_SERVER}__project_video_review_write`;

const PERSONA_PREFIX = 'A Project Video tool runs as a scheduled job, so its persona must be a file in '
  + '<cwd>/.claude/agents/ or ~/.claude/agents/:';

/**
 * MCP tool names a scope admits, derived exactly as jobToolScope does:
 * entries starting 'mcp__'; the name after the second '__'.
 * @param {{ tools: string[] }} scope
 * @returns {Set<string>}
 */
function mcpToolNamesFromScope(scope) {
  const names = new Set();
  for (const entry of scope.tools.map(String)) {
    if (!entry.startsWith('mcp__')) continue;
    const i = entry.indexOf('__', 5);
    if (i > 0) names.add(entry.slice(i + 2));
  }
  return names;
}

/**
 * @param {{ cwd: string, agentName: string, job?: { review?: boolean }|null }} input
 * @param {{ assertAgentTypeWritable?: Function, resolvePrdPersonaForSpawn?: Function }} [deps]
 * @returns {Promise<{ ok: true }|{ ok: false, error: string }>}
 */
async function checkProjectVideoToolRunnable({ cwd, agentName, job } = /** @type {any} */ ({}), deps = {}) {
  const assertWritable = deps.assertAgentTypeWritable
    || require('../prd/prdAgentType.cjs').assertAgentTypeWritable;
  const resolvePersona = deps.resolvePrdPersonaForSpawn
    || require('../claude/agentModelResolve.cjs').resolvePrdPersonaForSpawn;

  if (!agentName || typeof agentName !== 'string') {
    return { ok: false, error: `${PERSONA_PREFIX} no persona (agentName) is set.` };
  }
  try {
    await assertWritable(cwd, agentName);
  } catch (err) {
    const msg = err && /** @type {Error} */ (err).message ? /** @type {Error} */ (err).message : String(err);
    return { ok: false, error: `${PERSONA_PREFIX} ${msg}` };
  }

  let persona;
  try {
    persona = await resolvePersona({ cwd, agentType: agentName });
  } catch (err) {
    const msg = err && /** @type {Error} */ (err).message ? /** @type {Error} */ (err).message : String(err);
    return { ok: false, error: `${PERSONA_PREFIX} ${msg}` };
  }
  if (persona && persona.refusal) {
    return { ok: false, error: `${PERSONA_PREFIX} ${persona.refusal.code}: ${persona.refusal.detail}` };
  }
  if (!persona || !persona.personaPath) {
    return { ok: false, error: `${PERSONA_PREFIX} persona '${agentName}' could not be read.` };
  }

  const scope = buildPersonaToolScope(persona.tools, { loadout: persona.loadout });
  if (!scope) return { ok: true };

  const names = mcpToolNamesFromScope(scope);
  const needed = [['project_video_write', PROJECT_VIDEO_WRITE_ID]];
  if (job && job.review === true) needed.push(['project_video_review_write', PROJECT_VIDEO_REVIEW_WRITE_ID]);
  const missing = needed.filter(([name]) => !names.has(name)).map(([, id]) => id);
  if (missing.length === 0) return { ok: true };

  return {
    ok: false,
    error: `Persona '${agentName}' lists its tools, and a scheduled job can call only the MCP tools its persona lists. `
      + `Add ${missing.join(', ')} to the tools: line of ${persona.personaPath}, or the run cannot save its video.`,
  };
}

module.exports = {
  checkProjectVideoToolRunnable,
  mcpToolNamesFromScope,
  PROJECT_VIDEO_WRITE_ID,
  PROJECT_VIDEO_REVIEW_WRITE_ID,
};

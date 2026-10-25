'use strict';

/**
 * prdAgentType.cjs — the PRD-frontmatter `agentType` FK, mirroring
 * agentModelResolve.cjs's/epicMint.cjs's established convention for the
 * Epic-level `agentType` FK: THROW ON WRITE, REPORT ON READ.
 *
 * A PRD's `agentType` names the persona (`~/.claude/agents/<name>.md`, or a
 * project overlay at `<cwd>/.claude/agents/<name>.md`) that should execute
 * it — distinct from `tag` (workTypeLibrary.cjs), which is the WORK TYPE.
 * Reuses epicMint.cjs's personaFileExists/resolvePersonaPaths rather than a
 * second persona-file reader, and agentLibrary.cjs's listPersonas() for the
 * "available personas" name list surfaced in the write-time rejection error.
 */

const { personaFileExists, resolvePersonaPaths } = require('../epic/epicMint.cjs');
const { listPersonas } = require('../../agentLibrary.cjs');
const { splitFrontmatter } = require('./prdFrontmatter.cjs');
const fs = require('node:fs');

/** PRD execution's documented default persona (dev-lead.md's own frontmatter role). */
const DEFAULT_PRD_AGENT_TYPE = 'dev-lead';

// READ side of the FK — logged at most once per (cwd, agentType) so a hot
// reconcile/list pass re-parsing the same on-disk PRD every tick doesn't
// flood opsErrorLog's daily file. Mirrors agentModelResolve.cjs's
// loggedDanglingPersonas set.
const loggedDanglingAgentTypes = new Set();

/**
 * Read-time tolerance check: a PRD on disk whose persona was renamed or
 * deleted after the PRD was written must still load. Never throws — logs at
 * most once via opsErrorLog when `agentType` is set but unresolvable.
 */
function reportDanglingAgentTypeOnce(cwd, agentType, deps = {}) {
  if (!cwd || !agentType) return;
  try {
    const checkPersonaExists = deps.personaExists || personaFileExists;
    if (checkPersonaExists(cwd, agentType, deps)) return;
    const key = `${cwd}::${agentType}`;
    if (loggedDanglingAgentTypes.has(key)) return;
    loggedDanglingAgentTypes.add(key);
    // Required lazily, same rationale as agentModelResolve.cjs's
    // logDanglingPersonaOnce: pay for this leaf module only on the (rare)
    // miss path.
    const { appendError } = require('../telemetry/opsErrorLog.cjs');
    appendError({
      cwd,
      scope: 'prdAgentType',
      level: 'warn',
      message: `PRD agentType '${agentType}' has no resolvable persona file — PRD still loads`,
      meta: { agentType },
    });
  } catch { /* logging must never break PRD loading */ }
}

/**
 * Write-time FK check: throws when `agentType` is supplied but doesn't
 * resolve to a readable persona file, naming the available personas (from
 * the Agent Library) so the caller can pick a real one. A no-op when
 * `agentType` is falsy — the caller is expected to default it separately
 * (buildPrdBody's DEFAULT_PRD_AGENT_TYPE fill-in).
 */
async function assertAgentTypeWritable(cwd, agentType, deps = {}) {
  if (!agentType) return;
  const checkPersonaExists = deps.personaExists || personaFileExists;
  if (checkPersonaExists(cwd, agentType, deps)) return;

  const load = deps.listPersonas || listPersonas;
  let available = [];
  try {
    available = (await load()).map((p) => p.name).filter(Boolean).sort();
  } catch { /* best-effort — still throw below even if listing failed */ }

  const { projectPath, globalPath } = resolvePersonaPaths(cwd, agentType, deps);
  throw new Error(
    `agentType '${agentType}' does not resolve to a readable persona file — checked ${projectPath} and `
    + `${globalPath}. Available personas: ${available.length ? available.join(', ') : '(none found)'}`,
  );
}

/**
 * resolvePersonaDefaultEstimate(cwd, agentType, deps) — the persona's
 * optional `defaultEstimateMinutes` frontmatter (integer 1..60), project
 * overlay before global. Returns a number or null; never throws (missing,
 * malformed or out-of-range → null). Uncached sync read: called once per
 * job spawn.
 */
function resolvePersonaDefaultEstimate(cwd, agentType, deps = {}) {
  try {
    if (!cwd || typeof agentType !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(agentType)) return null;
    const { projectPath, globalPath } = resolvePersonaPaths(cwd, agentType, deps);
    for (const file of [projectPath, globalPath]) {
      let text;
      try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
      const raw = splitFrontmatter(text).fm.defaultEstimateMinutes;
      if (raw === undefined) continue;
      const str = String(raw).trim();
      if (!/^\d+$/.test(str)) continue;
      const n = Number(str);
      if (n >= 1 && n <= 60) return n;
    }
  } catch { /* never throws */ }
  return null;
}

module.exports = {
  DEFAULT_PRD_AGENT_TYPE,
  resolvePersonaDefaultEstimate,
  assertAgentTypeWritable,
  reportDanglingAgentTypeOnce,
};

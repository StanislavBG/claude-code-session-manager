'use strict';

/**
 * agentArmory.cjs — the Armory read model: one pure aggregate of catalogs that
 * already exist (built-in tools + bundled skills, configured MCP servers with
 * their last-known tools, packs + loose skills, tool-risk marks). No registry
 * file, no probes run here. Every source is injected (`deps`); a source that
 * throws adds a message to `errors` and leaves its group empty. Never throws.
 *
 * Deps (all optional, default to the real modules):
 *  - getBuiltinTools() -> { tools, skills }
 *  - listPacks() -> { packs, errors } ; listUnpackedSkills() -> string[]
 *  - listMcpServers({ cwd }) -> [{ name, scope }]  (same config reader as mcpToolsProbe)
 *  - getMcpProbe({ name, scope, cwd }) -> { ok, tools: (string|{name})[] } | null  (last result only)
 *  - loadMarks({ cwd }) -> { system, project } risk-mark layers
 *  - listEnvironments() -> { name, summary }[]  (default: built-in profiles of environmentProfiles.cjs)
 *  - bannedTools: string[]  (the scheduler's HEADLESS_DISALLOWED_TOOLS, passed by the caller)
 */

const os = require('node:os');
const path = require('node:path');

/** @param {unknown} e */
const msg = (e) => String((e && /** @type {Error} */ (e).message) || e);

/** Real MCP config reader: user ~/.claude.json + <cwd>/.mcp.json via claudeConfig (as mcpToolsProbe). */
async function defaultListMcpServers({ cwd }) {
  const claudeConfig = require('../claudeConfig.cjs');
  const out = [];
  const user = await claudeConfig.read({ fileId: 'claudeJson', scope: 'user', home: os.homedir() });
  for (const name of Object.keys((user.data && user.data.mcpServers) || {})) out.push({ name, scope: 'user' });
  if (typeof cwd === 'string' && path.isAbsolute(cwd)) {
    const proj = await claudeConfig.read({ fileId: 'mcpJson', scope: 'project', cwd });
    for (const name of Object.keys((proj.data && proj.data.mcpServers) || {})) out.push({ name, scope: 'project' });
  }
  return out;
}

function defaultListEnvironments() {
  const { BUILTIN_ENVIRONMENTS } = require('./environmentProfiles.cjs');
  return Object.entries(BUILTIN_ENVIRONMENTS).map(([name, p]) => ({ name, summary: p.description }));
}

function defaultLoadMarks({ cwd }) {
  const m = require('./toolRiskMarks.cjs');
  return {
    system: m.readMarksLayer(m.systemMarksPath(os.homedir())),
    project: typeof cwd === 'string' && cwd ? m.readMarksLayer(m.projectMarksPath(cwd)) : null,
  };
}

/**
 * @param {{ cwd?: string, deps?: Record<string, any> }} [opts]
 */
async function buildArmory({ cwd, deps } = {}) {
  const d = deps || {};
  /** @type {string[]} */ const errors = [];
  const out = { builtins: [], bundledSkills: [], mcpServers: [], packs: [], unpackedSkills: [], environments: [], errors };

  /** Run one source; on failure record and return the fallback. */
  const guard = async (label, fn, fallback) => {
    try { return await fn(); } catch (e) { errors.push(`${label}: ${msg(e)}`); return fallback; }
  };

  const banned = new Set(Array.isArray(d.bannedTools) ? d.bannedTools : []);
  let floor = [];
  try { floor = require('./personaToolScope.cjs').HEADLESS_TOOL_FLOOR; } catch (e) { errors.push(`toolFloor: ${msg(e)}`); }
  const floorSet = new Set(floor);

  const marks = await guard('toolRiskMarks', async () => (d.loadMarks || defaultLoadMarks)({ cwd }), null);
  const isRisky = (tool) => {
    if (!marks) return false;
    try { return !!require('./toolRiskMarks.cjs').resolveMark({ tool }, marks); } catch { return false; }
  };
  const badgesFor = (name, { floorable = true } = {}) => {
    /** @type {('risky'|'banned'|'floor')[]} */ const b = [];
    if (isRisky(name)) b.push('risky');
    if (banned.has(name)) b.push('banned');
    if (floorable && floorSet.has(name)) b.push('floor');
    return b;
  };
  const item = (name, opts) => ({ id: name, label: name, badges: badgesFor(name, opts) });

  const builtin = await guard('builtinTools', async () => (d.getBuiltinTools || require('./builtinTools.cjs').getBuiltinTools)(), null);
  if (builtin) {
    out.builtins = (builtin.tools || []).map((t) => item(t));
    out.bundledSkills = (builtin.skills || []).map((s) => item(s, { floorable: false }));
  }

  const packRes = await guard('packs', async () => (d.listPacks || require('../packs/packCatalog.cjs').listPacks)(), null);
  if (packRes) {
    out.packs = (packRes.packs || []).map((p) => ({
      id: p.id, label: p.label || p.id, badges: [], skills: [...(p.skills || [])], source: p.source,
    }));
    for (const e of packRes.errors || []) errors.push(`packs: ${e.dir}: ${e.error}`);
  }
  out.unpackedSkills = await guard('unpackedSkills', async () => [...(d.listUnpackedSkills || require('../packs/packCatalog.cjs').listUnpackedSkills)()], []);

  const servers = await guard('mcpServers', async () => (d.listMcpServers || defaultListMcpServers)({ cwd }), []);
  for (const s of servers) {
    let status = 'not-checked';
    let tools = [];
    try {
      const probe = d.getMcpProbe ? await d.getMcpProbe({ name: s.name, scope: s.scope, cwd }) : null;
      if (probe && probe.ok === false) status = 'failing';
      else if (probe && Array.isArray(probe.tools)) {
        status = 'checked';
        tools = probe.tools
          .map((t) => (typeof t === 'string' ? t : t && t.name))
          .filter((n) => typeof n === 'string' && n)
          .map((n) => ({ id: `mcp__${s.name}__${n}`, label: n, badges: badgesFor(`mcp__${s.name}__${n}`, { floorable: false }) }));
      }
    } catch (e) { errors.push(`mcpProbe ${s.name}: ${msg(e)}`); }
    out.mcpServers.push({ id: s.name, label: s.name, badges: [], tools, status, scope: s.scope });
  }

  out.environments = await guard('environments', async () => (d.listEnvironments || defaultListEnvironments)(), []);
  return out;
}

module.exports = { buildArmory };

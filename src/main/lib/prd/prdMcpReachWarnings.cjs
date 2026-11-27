/**
 * prdMcpReachWarnings.cjs — advisory rule: a PRD whose persona (declared mcpServers + mcp__<server>__
 * tools) or riskTools name an MCP server a headless job cannot load (undefined for the cwd, or
 * credential-bearing) will park capability_unknown / capability_credentialed. Never blocks a write,
 * never throws (an unreadable persona or resolver yields no warning). readPersonaServers returns null
 * when the persona is missing/unreadable (no warning at all, riskTools included) and an array — [] when
 * a readable persona declares no servers — otherwise.
 */
'use strict';

const RISK_MCP_RE = /^mcp__([^_](?:[^_]|_(?!_))*)__/;

/**
 * @param {any} input createPrd()'s input shape.
 * @param {{ resolve: (o: { cwd?: string }) => { known: Record<string, any>, credentialed: Record<string, string> },
 *           readPersonaServers: (input: any) => string[]|null }} deps
 * @returns {string[]}
 */
function mcpReachWarnings(input, deps) {
  try {
    const personaServers = deps.readPersonaServers(input);
    if (!Array.isArray(personaServers)) return [];
    const { known, credentialed } = deps.resolve({ cwd: input?.cwd });
    const out = [];
    for (const name of personaServers) {
      if (Object.prototype.hasOwnProperty.call(credentialed || {}, name)) {
        out.push(`persona MCP server \`${name}\` is credential-bearing (${credentialed[name]}) — the job will park capability_credentialed. Move the secret to a vault ref (environment profile) or drop the server from the persona.`);
      } else if (!Object.prototype.hasOwnProperty.call(known || {}, name)) {
        out.push(`persona MCP server \`${name}\` is not defined in ~/.claude.json, <cwd>/.mcp.json or the local project scope for this cwd — the job will park capability_unknown. Define the server there or remove it from the persona's tools/mcpServers.`);
      }
    }
    const seen = new Set();
    const risk = Array.isArray(input?.riskTools) ? input.riskTools : [];
    for (const rule of risk) {
      const m = typeof rule === 'string' ? RISK_MCP_RE.exec(rule) : null;
      if (!m || seen.has(m[1]) || personaServers.includes(m[1])) continue;
      seen.add(m[1]);
      out.push(`riskTools clears \`${rule}\` but the persona never loads MCP server \`${m[1]}\` — the tool is cleared yet unreachable. Add it to the persona's tools or mcpServers.`);
    }
    return out;
  } catch {
    return [];
  }
}

module.exports = { mcpReachWarnings };

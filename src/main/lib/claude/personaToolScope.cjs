'use strict';

/**
 * personaToolScope.cjs — turns a persona's `tools:` list into the claude CLI
 * args that actually ENFORCE it on a headless `claude -p` run.
 *
 * Verified on CLI 2.1.302: under `--dangerously-skip-permissions`,
 * `--allowedTools` restricts nothing and `--tools` only filters built-ins (MCP
 * tools stay). `--agents '<json>' --agent <name>` with a `tools` array enforces
 * exact per-tool scoping, MCP tools included, while the Claude Code harness
 * prompt, CLAUDE.md, `--append-system-prompt` and `--disallowedTools` keep
 * working.
 *
 * Pure: no fs, and no require of scheduler.cjs (cycle) — the caller passes its
 * HEADLESS_DISALLOWED_TOOLS list in.
 */

// Always granted to a scoped run: the finish protocol runs /code-review and
// /security-review (Skill + Agent); MCP tools are deferred, so ToolSearch is
// needed to reach them; TodoWrite is the run's own planning aid.
const HEADLESS_TOOL_FLOOR = Object.freeze(['Agent', 'Skill', 'ToolSearch', 'TodoWrite']);

const HEADLESS_SCOPE_AGENT_NAME = 'sm-headless-scoped';

/**
 * @param {readonly string[]|null|undefined} tools persona `tools:` list
 * @param {{ disallowed?: readonly string[] }} [opts]
 * @returns {{ tools: string[] }|null} null = persona declares no restriction
 */
function buildPersonaToolScope(tools, { disallowed = [] } = {}) {
  if (!Array.isArray(tools) || tools.length === 0) return null;
  const names = tools
    .filter((t) => typeof t === 'string')
    .map((t) => t.trim())
    .filter(Boolean);
  if (names.length === 0 || names.includes('*')) return null;
  const blocked = new Set(disallowed);
  const out = [];
  for (const name of [...names, ...HEADLESS_TOOL_FLOOR]) {
    if (blocked.has(name) || out.includes(name)) continue;
    out.push(name);
  }
  return { tools: out };
}

/**
 * @param {{ tools: string[] }|null} scope result of buildPersonaToolScope
 * @returns {string[]} argv fragment ([] when unscoped)
 */
function personaToolScopeArgs(scope) {
  if (!scope) return [];
  const def = {
    description: 'Headless run with a scheduler-enforced tool scope.',
    prompt: 'Tool scope is enforced by the scheduler.',
    tools: scope.tools,
  };
  return [
    '--agents', JSON.stringify({ [HEADLESS_SCOPE_AGENT_NAME]: def }),
    '--agent', HEADLESS_SCOPE_AGENT_NAME,
  ];
}

module.exports = {
  HEADLESS_TOOL_FLOOR,
  HEADLESS_SCOPE_AGENT_NAME,
  buildPersonaToolScope,
  personaToolScopeArgs,
};

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
 * Scoping is focus, not containment: the scope decides which tools a job is
 * offered. Every headless job runs as the owner's OS user. Sandboxed personas
 * (validator, dev-lead when the OS sandbox is available) no longer run with
 * --dangerously-skip-permissions; every other job still does, under secret-path
 * deny rules — see jobSandboxPolicy.cjs. Either way a job with Bash can still
 * start an MCP server or call the admin API itself.
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
 * @param {{ loadout?: 'undecided'|'bare'|'equipped'|'unbound', disallowed?: readonly string[], structuredOutput?: boolean }} [opts]
 *   structuredOutput: also grant the CLI's StructuredOutput tool (a --json-schema
 *   run). Probe 2026-11-22 (CLI 2.1.325): a scoped run without it ends
 *   'success' with structured_output null — the schema is silently skipped.
 * @returns {{ tools: string[] }|null} null = persona declares no restriction
 */
function buildPersonaToolScope(tools, { loadout, disallowed = [], structuredOutput = false } = {}) {
  // `loadout` (personaLoadout.cjs) wins when given: Bare = floor only even for
  // an empty list; Unbound/Undecided = unscoped.
  if (loadout === 'unbound' || loadout === 'undecided') return null;
  const bare = loadout === 'bare';
  const list = Array.isArray(tools) ? tools : [];
  if (!bare && list.length === 0) return null;
  const names = list
    .filter((t) => typeof t === 'string')
    .map((t) => t.trim())
    .filter(Boolean);
  if (names.includes('*')) return null;
  if (!bare && names.length === 0) return null;
  const blocked = new Set(disallowed);
  const out = [];
  const extra = structuredOutput === true ? ['StructuredOutput'] : [];
  for (const name of [...(bare ? [] : names), ...HEADLESS_TOOL_FLOOR, ...extra]) {
    if (blocked.has(name) || out.includes(name)) continue;
    out.push(name);
  }
  return { tools: out };
}

/** Server name of an mcp__<server>__<tool> entry ('' when malformed). */
function mcpServerOf(tool) {
  return String(tool).slice(5).split('__')[0];
}

const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

/**
 * The argv that loads EXACTLY a job's MCP servers, fail-closed.
 *
 * Always pushes --strict-mcp-config (the CLI then ignores the user/project
 * MCP config). The server set = the persona's declared `mcpServers:` plus the
 * servers named by its mcp__<server>__<tool> tools; each must resolve in the
 * known map, and only those are passed via --mcp-config. Any name that does
 * not resolve — and any declared pack not in `knownPacks` — is a refusal
 * { code: 'capability_unknown', name } (first one found); the caller parks
 * the job naming it. There is no widening branch: an unknown server never
 * loads every server.
 *
 * @param {{ tools: string[] }|null} scope result of buildPersonaToolScope (null = unscoped tools)
 * @param {{ mcpServers?: Record<string, object>, declaredServers?: readonly string[], packs?: readonly string[], knownPacks?: readonly string[] }} [opts]
 *   mcpServers: known server definitions by name. declaredServers: the
 *   persona's `mcpServers:`. packs / knownPacks: the job's packs and those the
 *   catalog resolves.
 * @returns {{ args: string[], refusal: null|{ code: 'capability_unknown', name: string } }}
 */
function personaToolScopeArgs(scope, { mcpServers, declaredServers = [], packs = [], knownPacks = [] } = {}) {
  /** @type {string[]} */
  const args = [];
  /** @type {null|{ code: 'capability_unknown', name: string }} */
  let refusal = null;
  const refuse = (name) => { if (!refusal) refusal = { code: 'capability_unknown', name }; };
  const known = mcpServers || {};
  /** @type {string[]} */
  const named = [];
  for (const d of Array.isArray(declaredServers) ? declaredServers : []) {
    const n = String(d).trim();
    if (n && !named.includes(n)) named.push(n);
  }
  const mcpTools = scope ? scope.tools.map(String).filter((t) => t.startsWith('mcp__')) : [];
  for (const t of mcpTools) {
    const n = mcpServerOf(t);
    if (!n) { refuse(t); continue; }
    if (!named.includes(n)) named.push(n);
  }
  /** @type {Record<string, object>} */
  const picked = {};
  for (const n of named) {
    if (hasOwn(known, n)) picked[n] = known[n];
    else refuse(n);
  }
  const knownPackSet = new Set(Array.isArray(knownPacks) ? knownPacks.map(String) : []);
  for (const p of Array.isArray(packs) ? packs : []) {
    if (!knownPackSet.has(String(p))) refuse(String(p));
  }
  if (scope) {
    // The --agents tools array scopes MCP tools too (probe 2026-11-27, CLI
    // 2.1.330): a loaded server whose tools the array never names is invisible,
    // even to ToolSearch. A server the persona DECLARES (mcpServers:) and names
    // no single tool of is granted whole via the server-level `mcp__<server>`.
    const tools = [...scope.tools];
    for (const d of Array.isArray(declaredServers) ? declaredServers : []) {
      const n = String(d).trim();
      if (!n || !hasOwn(picked, n) || mcpTools.some((t) => mcpServerOf(t) === n)) continue;
      const whole = `mcp__${n}`;
      if (!tools.includes(whole)) tools.push(whole);
    }
    const def = {
      description: 'Headless run with a scheduler-enforced tool scope.',
      prompt: 'Tool scope is enforced by the scheduler.',
      tools,
    };
    args.push('--agents', JSON.stringify({ [HEADLESS_SCOPE_AGENT_NAME]: def }), '--agent', HEADLESS_SCOPE_AGENT_NAME);
  }
  // --mcp-config is variadic: it is followed immediately by --strict-mcp-config.
  // With no server, no --mcp-config at all — strict mode alone boots none.
  if (Object.keys(picked).length) args.push('--mcp-config', JSON.stringify({ mcpServers: picked }));
  args.push('--strict-mcp-config');
  return { args, refusal };
}

/**
 * The resolved MCP server set a job runs with: declared + tool-named, sorted,
 * unique (the AgentSnapshot's `mcpServers`).
 * @param {readonly string[]|null|undefined} tools
 * @param {readonly string[]|null|undefined} declared
 * @returns {string[]}
 */
function resolvedMcpServerNames(tools, declared) {
  const names = new Set();
  for (const d of Array.isArray(declared) ? declared : []) { const n = String(d).trim(); if (n) names.add(n); }
  for (const t of Array.isArray(tools) ? tools.map(String) : []) {
    if (!t.startsWith('mcp__')) continue;
    const n = mcpServerOf(t);
    if (n) names.add(n);
  }
  return [...names].sort();
}

const JOB_MCP_TOOLS_ENV = 'SM_SCHEDULER_JOB_MCP_TOOLS';

/**
 * Env fragment a scoped job carries so an out-of-process MCP server can tell
 * which MCP tools the scope admits. scripts/scheduler-mcp-server.cjs reads it
 * to list and serve only in-scope tools. The value is always a JSON array
 * string; '[]' means no MCP tool.
 * @param {{ tools: string[] }|null|undefined} scope
 * @returns {Record<string, string>} {} when unscoped
 */
function personaToolScopeEnv(scope) {
  if (!scope) return {};
  const mcp = scope.tools.map(String).filter((t) => t.startsWith('mcp__'));
  return { [JOB_MCP_TOOLS_ENV]: JSON.stringify(mcp) };
}

/**
 * The `--disallowedTools=Skill(<name>)` argv that refuses every installed
 * skill a persona's equipped packs do not carry. Skills ride only inside packs.
 * Verified on CLI 2.1.330: a denied Skill call fails with 'Skill execution
 * blocked by permission rules'. Always the --flag=value form (only the first
 * value after a variadic flag is literal). Pure: the caller passes the catalog.
 *
 * Unbound/undecided loadouts deny nothing; Bare ignores equipped packs. CLI-bundled
 * skills follow the built-in tool decision and are never denied; `alwaysAllowed`
 * (finish protocol: code-review, security-review) never are either.
 *
 * @param {{ installedSkills?: readonly string[], equippedPacks?: readonly string[],
 *   packCatalog?: readonly { id: string, skills?: readonly string[] }[],
 *   bundledSkills?: readonly string[], loadout?: string,
 *   alwaysAllowed?: readonly string[] }} [opts]
 * @returns {string[]}
 */
function skillDenyArgs({
  installedSkills = [], equippedPacks = [], packCatalog = [], bundledSkills = [],
  loadout, alwaysAllowed = ['code-review', 'security-review'],
} = {}) {
  if (loadout === 'unbound' || loadout === 'undecided') return [];
  const allowed = new Set([...bundledSkills, ...alwaysAllowed].map(String));
  if (loadout !== 'bare') {
    const equipped = new Set(equippedPacks.map(String));
    for (const pack of packCatalog) {
      if (!pack || !equipped.has(String(pack.id))) continue;
      for (const s of pack.skills || []) allowed.add(String(s));
    }
  }
  const out = [];
  for (const raw of installedSkills) {
    const name = String(raw).trim();
    if (!name || allowed.has(name) || out.includes(`--disallowedTools=Skill(${name})`)) continue;
    out.push(`--disallowedTools=Skill(${name})`);
  }
  return out;
}

/**
 * The skill-deny argv for one unattended spawn (job or Task): the real catalogs
 * (packs, loose skills, CLI-bundled skills) fed to skillDenyArgs. Never throws;
 * a catalog failure denies nothing (same as an unbound loadout).
 * @param {{ packs?: readonly string[], loadout?: string|null, deps?: Record<string, any> }} [o]
 * @returns {Promise<{ args: string[], denied: number }>}
 */
async function resolveSkillDeny({ packs = [], loadout, deps } = {}) {
  const d = deps || {};
  try {
    if (!loadout) return { args: [], denied: 0 };
    const catalog = require('../packs/packCatalog.cjs');
    const packCatalog = (d.listPacks || catalog.listPacks)().packs || [];
    const unpacked = [...(d.listUnpackedSkills || catalog.listUnpackedSkills)()];
    const builtin = await (d.getBuiltinTools || require('./builtinTools.cjs').getBuiltinTools)();
    const bundledSkills = (builtin && builtin.skills) || [];
    const installedSkills = [...new Set([...packCatalog.flatMap((p) => p.skills || []), ...unpacked])];
    const args = skillDenyArgs({ installedSkills, equippedPacks: packs, packCatalog, bundledSkills, loadout });
    return { args, denied: args.length };
  } catch {
    return { args: [], denied: 0 };
  }
}

module.exports = {
  resolveSkillDeny,
  JOB_MCP_TOOLS_ENV,
  personaToolScopeEnv,
  HEADLESS_TOOL_FLOOR,
  HEADLESS_SCOPE_AGENT_NAME,
  buildPersonaToolScope,
  skillDenyArgs,
  personaToolScopeArgs,
  resolvedMcpServerNames,
};

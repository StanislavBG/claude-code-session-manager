/**
 * Delegation-readiness probe — answers "can this project actually hand work
 * to the scheduler?" as structured data instead of a silent tool-list gap.
 *
 * Why this exists: when the session-manager-scheduler MCP server isn't
 * registered, `scheduler_create_prd` is simply absent from the agent's tool
 * list — there's no error to catch, so an agent asked to delegate just
 * implements inline instead. See scripts/install-scheduler-mcp-user-scope.sh's
 * header for the incident this repeat-guards against (PRD 1024-1030).
 *
 * This module only computes the four checks below; surfacing them in the UI
 * or the Epic's grounding line is a dependent PRD (delegation-readiness-ui).
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { writeJson, addAllowedRoot } = require('../config.cjs');

const SCHEDULER_MCP_NAME = 'session-manager-scheduler';
const DEV_PLUGIN_ENABLED_KEY = 'session-manager-dev@session-manager';
const SCHEDULER_MCP_SERVER_SCRIPT = path.resolve(__dirname, '..', '..', '..', 'scripts', 'scheduler-mcp-server.cjs');
const PRD_WRITE_GUARD_SCRIPT = path.resolve(__dirname, '..', '..', '..', 'scripts', 'hooks', 'guard-prd-writes.cjs');
const PRD_WRITE_GUARD_MATCHER = 'Write|Edit|NotebookEdit';

/** Read + JSON.parse a file, returning `fallback` on any read/parse failure. */
function readJsonSafe(absPath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(absPath, 'utf8'));
  } catch {
    return fallback;
  }
}

function checkSchedulerMcp({ cwd, homeDir }) {
  const userConfig = readJsonSafe(path.join(homeDir, '.claude.json'), null);
  const userHas = !!userConfig?.mcpServers?.[SCHEDULER_MCP_NAME];

  const projectConfig = readJsonSafe(path.join(cwd, '.mcp.json'), null);
  const projectHas = !!projectConfig?.mcpServers?.[SCHEDULER_MCP_NAME];

  const ok = userHas || projectHas;
  let detail;
  if (userHas) detail = `${SCHEDULER_MCP_NAME} registered at user scope (~/.claude.json)`;
  else if (projectHas) detail = `${SCHEDULER_MCP_NAME} registered at project scope (${cwd}/.mcp.json)`;
  else detail = `no ${SCHEDULER_MCP_NAME} entry in ~/.claude.json or ${cwd}/.mcp.json`;

  return {
    id: 'scheduler-mcp',
    label: 'Scheduler MCP server registered',
    ok,
    detail,
    fix: ok
      ? null
      : `claude mcp add ${SCHEDULER_MCP_NAME} --scope user -- node ${SCHEDULER_MCP_SERVER_SCRIPT}`,
  };
}

function checkDevPlugin({ homeDir }) {
  const settings = readJsonSafe(path.join(homeDir, '.claude', 'settings.json'), null);
  const ok = settings?.enabledPlugins?.[DEV_PLUGIN_ENABLED_KEY] === true;

  return {
    id: 'dev-plugin',
    label: 'session-manager-dev plugin enabled',
    ok,
    detail: ok
      ? `${DEV_PLUGIN_ENABLED_KEY} enabled in ~/.claude/settings.json`
      : `${DEV_PLUGIN_ENABLED_KEY} missing from ~/.claude/settings.json enabledPlugins`,
    fix: ok ? null : 'Enable in Plugins tab: session-manager-dev (Session Manager)',
  };
}

// Personas resolve from BOTH scopes (agentLibrary.cjs: "project cwd wins
// over the global" one) — a project that only ever defines project-scoped
// overrides in `<cwd>/.claude/agents/` (this repo's own `.claude/agents/`
// is exactly that case) is a legitimately delegation-ready project, not a
// failing one, so both directories must be counted.
function countMdFiles(dir) {
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith('.md')).length;
  } catch {
    return 0;
  }
}

function checkAgentPersonas({ cwd, homeDir }) {
  const globalCount = countMdFiles(path.join(homeDir, '.claude', 'agents'));
  const projectCount = countMdFiles(path.join(cwd, '.claude', 'agents'));
  const count = globalCount + projectCount;
  const ok = count > 0;

  return {
    id: 'agent-personas',
    label: 'At least one agent persona defined',
    ok,
    detail: ok
      ? `${count} persona(s) across ~/.claude/agents/ and ${cwd}/.claude/agents/`
      : `no .md personas in ~/.claude/agents/ or ${cwd}/.claude/agents/`,
    fix: ok ? null : 'Create a persona in the Agent Library tab',
  };
}

/**
 * Pull the guard script's path out of a hook `command` string.
 *
 * Commands are `node <script>` (optionally quoted). We only care about the
 * token naming guard-prd-writes — anything else is not this hook.
 */
function extractGuardScriptPath(command) {
  const match = String(command).match(/(?:"([^"]*guard-prd-writes\.cjs)"|'([^']*guard-prd-writes\.cjs)'|(\S*guard-prd-writes\.cjs))/);
  if (!match) return null;
  return match[1] || match[2] || match[3] || null;
}

/**
 * `ok` must mean "a hook that will actually run", not "the settings file
 * mentions guard-prd-writes somewhere".
 *
 * The failure mode this guards against: a PreToolUse command that exits
 * non-zero WITHOUT exit code 2 is a non-blocking error, so a hook pointing at
 * a script that doesn't exist in this project silently guards nothing — while
 * a substring match would flip this check green. That is strictly worse than
 * an honest red. So we resolve the command's script path (relative resolves
 * against the project cwd, which is what the harness runs the hook with) and
 * require the file to exist on disk.
 */
function checkPrdWriteGuard({ cwd }) {
  const settings = readJsonSafe(path.join(cwd, '.claude', 'settings.json'), null);
  const preToolUse = Array.isArray(settings?.hooks?.PreToolUse) ? settings.hooks.PreToolUse : [];

  let mentioned = false;
  let resolvedScript = null;
  for (const matcher of preToolUse) {
    if (!Array.isArray(matcher?.hooks)) continue;
    for (const h of matcher.hooks) {
      if (typeof h?.command !== 'string' || !h.command.includes('guard-prd-writes')) continue;
      mentioned = true;
      const raw = extractGuardScriptPath(h.command);
      if (!raw) continue;
      const abs = path.isAbsolute(raw) ? raw : path.resolve(cwd, raw);
      if (fs.existsSync(abs)) { resolvedScript = abs; break; }
    }
    if (resolvedScript) break;
  }

  const ok = !!resolvedScript;
  let detail;
  if (ok) detail = `guard-prd-writes PreToolUse hook found in ${cwd}/.claude/settings.json, resolving to ${resolvedScript}`;
  else if (mentioned) detail = `guard-prd-writes PreToolUse hook in ${cwd}/.claude/settings.json names a script that does not exist — it would silently guard nothing`;
  else detail = `no guard-prd-writes PreToolUse hook in ${cwd}/.claude/settings.json`;

  return {
    id: 'prd-write-guard',
    label: 'PRD-write guard hook installed',
    ok,
    detail,
    fix: ok
      ? null
      : `Add a PreToolUse hook to ${cwd}/.claude/settings.json matching Write|Edit|NotebookEdit that runs node ${PRD_WRITE_GUARD_SCRIPT}`,
    // The one check with a sanctioned one-press install (installPrdWriteGuard).
    fixAction: ok ? null : 'install-prd-write-guard',
  };
}


/**
 * Install the PRD-write guard into `<cwd>/.claude/settings.json`.
 *
 * ── The standardized approach is REFERENCE, not vendor ────────────────────
 * The hook command points at session-manager's own copy of
 * scripts/hooks/guard-prd-writes.cjs by ABSOLUTE path. We deliberately do NOT
 * copy the script into the adopting repo:
 *
 *  - Vendoring drifts. It already did, with exactly one adopter
 *    (social-signals-trader's copy is missing the 26-line adoption header).
 *  - The thing being guarded is `session-manager-operations/scheduler/` —
 *    Session Manager's own territory in someone else's repo. The enforcement
 *    logic belongs with the owner, not forked into every consumer.
 *  - Adopting repos need no Node toolchain of their own; `node` plus this
 *    absolute path is the entire dependency.
 *
 * The liability of reference — a silently-no-op hook if the script ever moves
 * — is closed by checkPrdWriteGuard() above, which resolves the command's
 * script path and fails the check when the file is gone.
 *
 * Merges into any existing hooks block rather than clobbering it: other
 * PreToolUse matchers, other hooks under the same matcher, and every unrelated
 * settings key are preserved. Idempotent — a healthy guard is a no-op, and a
 * guard entry pointing at a missing script is repaired in place.
 */
async function installPrdWriteGuard({ cwd }) {
  const settingsPath = path.join(cwd, '.claude', 'settings.json');
  // config.cjs's validateWrite only permits `<registered project root>/.claude/**`,
  // and a project the user is merely *pointing* the New Epic dialog at may
  // never have spawned a pty — same cold-boot hazard config.cjs:73-81 already
  // documents for PromptSession archive writes. `cwd` here IS a project root.
  addAllowedRoot(cwd);

  const existing = fs.existsSync(settingsPath) ? readJsonSafe(settingsPath, undefined) : {};
  if (existing === undefined) {
    // Unparseable settings — refuse rather than silently discarding whatever
    // the human has in there.
    return { ok: false, action: 'error', error: `${settingsPath} is not valid JSON — fix it by hand before installing the guard` };
  }
  const settings = (existing && typeof existing === 'object' && !Array.isArray(existing)) ? existing : {};

  const command = `node ${PRD_WRITE_GUARD_SCRIPT}`;
  const hooks = (settings.hooks && typeof settings.hooks === 'object') ? settings.hooks : {};
  const preToolUse = Array.isArray(hooks.PreToolUse) ? hooks.PreToolUse.slice() : [];

  // Already healthy? Nothing to do.
  if (checkPrdWriteGuard({ cwd }).ok) {
    return { ok: true, action: 'already-installed', settingsPath, command };
  }

  // Repair a broken entry in place, wherever it sits, before appending.
  let repaired = false;
  for (const matcher of preToolUse) {
    if (!Array.isArray(matcher?.hooks)) continue;
    for (const h of matcher.hooks) {
      if (typeof h?.command === 'string' && h.command.includes('guard-prd-writes')) {
        h.command = command;
        h.type = 'command';
        repaired = true;
      }
    }
  }

  if (!repaired) {
    const target = preToolUse.find((m) => m?.matcher === PRD_WRITE_GUARD_MATCHER);
    if (target) {
      target.hooks = Array.isArray(target.hooks) ? target.hooks : [];
      target.hooks.push({ type: 'command', command });
    } else {
      preToolUse.push({ matcher: PRD_WRITE_GUARD_MATCHER, hooks: [{ type: 'command', command }] });
    }
  }

  const next = { ...settings, hooks: { ...hooks, PreToolUse: preToolUse } };
  await writeJson(settingsPath, next);

  return { ok: true, action: repaired ? 'repaired' : 'installed', settingsPath, command };
}

/**
 * Runs all four delegation-readiness checks for `cwd`. Every filesystem read
 * is wrapped (readJsonSafe / try-catch) so a missing or unparseable file
 * yields ok:false with a detail, never a thrown exception.
 */
function checkDelegationReadiness({ cwd, homeDir = os.homedir() }) {
  // `fixAction: null` is the default — only a check with a sanctioned
  // one-press installer overrides it (today: prd-write-guard).
  const checks = [
    checkSchedulerMcp({ cwd, homeDir }),
    checkDevPlugin({ homeDir }),
    checkAgentPersonas({ cwd, homeDir }),
    checkPrdWriteGuard({ cwd }),
  ].map((c) => ({ fixAction: null, ...c }));

  return {
    ok: checks.every((c) => c.ok),
    checks,
  };
}

module.exports = { checkDelegationReadiness, installPrdWriteGuard, PRD_WRITE_GUARD_SCRIPT, PRD_WRITE_GUARD_MATCHER };

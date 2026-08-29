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

const SCHEDULER_MCP_NAME = 'session-manager-scheduler';
const DEV_PLUGIN_ENABLED_KEY = 'session-manager-dev@session-manager';
const SCHEDULER_MCP_SERVER_SCRIPT = path.resolve(__dirname, '..', '..', '..', 'scripts', 'scheduler-mcp-server.cjs');

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

function checkPrdWriteGuard({ cwd }) {
  const settings = readJsonSafe(path.join(cwd, '.claude', 'settings.json'), null);
  const preToolUse = Array.isArray(settings?.hooks?.PreToolUse) ? settings.hooks.PreToolUse : [];
  const ok = preToolUse.some((matcher) =>
    Array.isArray(matcher?.hooks) &&
    matcher.hooks.some((h) => typeof h?.command === 'string' && h.command.includes('guard-prd-writes'))
  );

  return {
    id: 'prd-write-guard',
    label: 'PRD-write guard hook installed',
    ok,
    detail: ok
      ? `guard-prd-writes PreToolUse hook found in ${cwd}/.claude/settings.json`
      : `no guard-prd-writes PreToolUse hook in ${cwd}/.claude/settings.json`,
    fix: ok
      ? null
      : `Add a PreToolUse hook to ${cwd}/.claude/settings.json matching Write|Edit|NotebookEdit that runs node scripts/hooks/guard-prd-writes.cjs`,
  };
}

/**
 * Runs all four delegation-readiness checks for `cwd`. Every filesystem read
 * is wrapped (readJsonSafe / try-catch) so a missing or unparseable file
 * yields ok:false with a detail, never a thrown exception.
 */
function checkDelegationReadiness({ cwd, homeDir = os.homedir() }) {
  const checks = [
    checkSchedulerMcp({ cwd, homeDir }),
    checkDevPlugin({ homeDir }),
    checkAgentPersonas({ cwd, homeDir }),
    checkPrdWriteGuard({ cwd }),
  ];

  return {
    ok: checks.every((c) => c.ok),
    checks,
  };
}

module.exports = { checkDelegationReadiness };

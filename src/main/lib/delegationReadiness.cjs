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
 * This module only computes the checks below; surfacing them in the UI or
 * the Epic's grounding line is a dependent PRD (delegation-readiness-ui).
 * A registration key existing in ~/.claude.json is necessary but NOT
 * sufficient — scheduler-mcp-live actually spawns the registered server and
 * confirms it answers tools/list, closing the gap where a moved repo, a
 * missing `node`, or a syntax error in the server showed GREEN forever.
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { writeJson, addAllowedRoot } = require('../config.cjs');
const { cleanChildEnv, pathWithUserBins } = require('./cleanEnv.cjs');

const SCHEDULER_MCP_NAME = 'session-manager-scheduler';
const DEV_PLUGIN_ENABLED_KEY = 'session-manager-dev@session-manager';
const SCHEDULER_MCP_SERVER_SCRIPT = path.resolve(__dirname, '..', '..', '..', 'scripts', 'scheduler-mcp-server.cjs');
const PRD_WRITE_GUARD_SCRIPT = path.resolve(__dirname, '..', '..', '..', 'scripts', 'hooks', 'guard-prd-writes.cjs');
const PRD_WRITE_GUARD_MATCHER = 'Write|Edit|NotebookEdit';
const LIVE_PROBE_TIMEOUT_MS = 10_000;
const LIVE_PROBE_TTL_MS = 60_000;
const REQUIRED_LIVE_TOOLS = ['scheduler_create_prd', 'session_manager_help'];

/** Read + JSON.parse a file, returning `fallback` on any read/parse failure. */
function readJsonSafe(absPath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(absPath, 'utf8'));
  } catch {
    return fallback;
  }
}

const SCHEDULER_MCP_FIX_CMD = `claude mcp add ${SCHEDULER_MCP_NAME} --scope user -- node ${SCHEDULER_MCP_SERVER_SCRIPT}`;

/**
 * `ok` must mean "an agent in this project can actually reach a working
 * server", not "some entry named session-manager-scheduler exists somewhere".
 * A user-scope entry whose script path is relative or points at a file that
 * no longer exists (repo moved, worktree deleted) is exactly as dead as no
 * entry at all — the difference is it shows GREEN under a substring check,
 * which is the incident this PRD closes.
 */
function checkSchedulerMcp({ cwd, homeDir }) {
  const userConfig = readJsonSafe(path.join(homeDir, '.claude.json'), null);
  const userEntry = userConfig?.mcpServers?.[SCHEDULER_MCP_NAME];

  const projectConfig = readJsonSafe(path.join(cwd, '.mcp.json'), null);
  const projectHas = !!projectConfig?.mcpServers?.[SCHEDULER_MCP_NAME];

  if (userEntry) {
    const args = Array.isArray(userEntry.args) ? userEntry.args : [];
    const scriptArg = args[args.length - 1];
    const isAbsolute = typeof scriptArg === 'string' && path.isAbsolute(scriptArg);
    const exists = isAbsolute && fs.existsSync(scriptArg);
    if (!isAbsolute || !exists) {
      return {
        id: 'scheduler-mcp',
        label: 'Scheduler MCP server registered',
        ok: false,
        detail: !isAbsolute
          ? `user-scope ${SCHEDULER_MCP_NAME} registration points at a non-absolute script path (${scriptArg})`
          : `user-scope ${SCHEDULER_MCP_NAME} registration points at a script that no longer exists (${scriptArg})`,
        fix: SCHEDULER_MCP_FIX_CMD,
      };
    }
    return {
      id: 'scheduler-mcp',
      label: 'Scheduler MCP server registered',
      ok: true,
      detail: `${SCHEDULER_MCP_NAME} registered at user scope (~/.claude.json)`,
      fix: null,
    };
  }

  if (projectHas) {
    return {
      id: 'scheduler-mcp',
      label: 'Scheduler MCP server registered',
      ok: true,
      detail: `${SCHEDULER_MCP_NAME} registered at project scope (${cwd}/.mcp.json)`,
      fix: null,
    };
  }

  return {
    id: 'scheduler-mcp',
    label: 'Scheduler MCP server registered',
    ok: false,
    detail: `no ${SCHEDULER_MCP_NAME} entry in ~/.claude.json or ${cwd}/.mcp.json`,
    fix: SCHEDULER_MCP_FIX_CMD,
  };
}

/**
 * A project-scope `.mcp.json` entry is never wrong by itself, but once a
 * user-scope entry also exists it is pure risk: `.mcp.json` commonly carries
 * a RELATIVE script path (this repo's own copy did, until this PRD), and a
 * relative path resolves against the process's cwd — which is the worktree
 * root for an Epic, not this repo root — silently shadowing the working
 * user-scope registration with a broken one. Reported as a warning, never a
 * failure: enabling/disabling project-scope servers is the human's call
 * (enableAllProjectMcpServers), not something this probe decides.
 */
function checkSchedulerMcpProjectDuplicate({ cwd, homeDir }) {
  const userConfig = readJsonSafe(path.join(homeDir, '.claude.json'), null);
  const userHas = !!userConfig?.mcpServers?.[SCHEDULER_MCP_NAME];

  const projectConfig = readJsonSafe(path.join(cwd, '.mcp.json'), null);
  const projectHas = !!projectConfig?.mcpServers?.[SCHEDULER_MCP_NAME];

  const warn = userHas && projectHas;
  return {
    id: 'scheduler-mcp-project-duplicate',
    label: 'No project-scope duplicate of the scheduler MCP',
    ok: true,
    warn,
    detail: warn
      ? `${cwd}/.mcp.json ALSO registers ${SCHEDULER_MCP_NAME} — user scope is canonical; this project entry can shadow it (e.g. via a relative script path resolved against a worktree cwd) instead of adding coverage`
      : `no project-scope duplicate of ${SCHEDULER_MCP_NAME} in ${cwd}/.mcp.json`,
    fix: warn
      ? `Remove the ${SCHEDULER_MCP_NAME} entry from ${cwd}/.mcp.json — the user-scope registration already covers every project`
      : null,
  };
}

/** Cache key: a fresh registration signature (command+args+env) always misses. */
function liveProbeSignature({ command, args, env }) {
  return JSON.stringify({ command, args, env: env || {} });
}

const liveProbeCache = new Map(); // signature -> { result: Promise, expiresAt }

/** Test-only: forces the next probe for every signature to actually spawn. */
function clearLiveProbeCache() {
  liveProbeCache.clear();
}

/**
 * Spawns the registered command+args with the registered env (via
 * cleanChildEnv/pathWithUserBins — the same env the scheduler gives
 * `claude -p`, so this fails the way a real session would fail, not the way
 * the Electron process would), sends an initialize + tools/list JSON-RPC
 * pair over stdin, and resolves once a tools/list result naming every entry
 * in REQUIRED_LIVE_TOOLS arrives, or the 10s bound is hit. Never rejects,
 * never leaves the child running — every path clears the timer and kills it.
 */
function probeSchedulerMcpLive({ command, args, env }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, {
        cwd: os.homedir(),
        env: cleanChildEnv({ PATH: pathWithUserBins(), ...(env || {}) }),
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      resolve({ ok: false, detail: err?.message ?? String(err) });
      return;
    }

    let settled = false;
    let stdoutBuf = '';
    let firstStderrLine = null;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      resolve(result);
    };

    const timer = setTimeout(() => finish({ ok: false, detail: 'timeout' }), LIVE_PROBE_TIMEOUT_MS);

    child.on('error', (err) => finish({ ok: false, detail: err?.message ?? String(err) }));

    child.stderr?.on('data', (chunk) => {
      if (firstStderrLine != null) return;
      const line = chunk.toString('utf8').split('\n').find((l) => l.trim());
      if (line) firstStderrLine = line.trim();
    });

    child.stdout?.on('data', (chunk) => {
      stdoutBuf += chunk.toString('utf8');
      let idx;
      while ((idx = stdoutBuf.indexOf('\n')) !== -1) {
        const line = stdoutBuf.slice(0, idx).trim();
        stdoutBuf = stdoutBuf.slice(idx + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg && msg.id === 2) {
          const tools = Array.isArray(msg.result?.tools) ? msg.result.tools.map((t) => t?.name) : null;
          if (!tools) {
            finish({ ok: false, detail: msg.error?.message ? `tools/list error: ${msg.error.message}` : 'tools/list returned no tools array' });
            return;
          }
          const missing = REQUIRED_LIVE_TOOLS.filter((t) => !tools.includes(t));
          if (missing.length > 0) {
            finish({ ok: false, detail: `tools/list did not include: ${missing.join(', ')}` });
          } else {
            finish({ ok: true, detail: `tools/list returned ${tools.length} tool(s) including ${REQUIRED_LIVE_TOOLS.join(', ')}` });
          }
          return;
        }
      }
    });

    child.on('close', () => {
      finish({ ok: false, detail: firstStderrLine || 'process exited before answering tools/list' });
    });

    try {
      const initialize = {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'sm-readiness', version: '1' } },
      };
      const toolsList = { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} };
      child.stdin.write(`${JSON.stringify(initialize)}\n`);
      child.stdin.write(`${JSON.stringify(toolsList)}\n`);
    } catch (err) {
      finish({ ok: false, detail: err?.message ?? String(err) });
    }
  });
}

function probeSchedulerMcpLiveMemoized({ command, args, env }) {
  const sig = liveProbeSignature({ command, args, env });
  const now = Date.now();
  const cached = liveProbeCache.get(sig);
  if (cached && cached.expiresAt > now) return cached.result;

  const result = probeSchedulerMcpLive({ command, args, env });
  liveProbeCache.set(sig, { result, expiresAt: now + LIVE_PROBE_TTL_MS });
  return result;
}

/**
 * Answers "does the server process actually answer", which
 * checkSchedulerMcp's static-config check cannot — a registration can point
 * at a script that spawns and dies on a syntax error, or at `node` when
 * `node` isn't on PATH for a real session's env, and both show GREEN there.
 * Skipped (not failed) when the registration check already failed, so a
 * missing entry produces one red row, not two.
 */
async function checkSchedulerMcpLive({ cwd, homeDir, schedulerMcpCheck }) {
  const base = { id: 'scheduler-mcp-live', label: 'Scheduler MCP server answers tools/list' };

  if (!schedulerMcpCheck.ok) {
    return { ...base, ok: true, skipped: true, detail: 'skipped — scheduler-mcp registration check already failed', fix: null };
  }

  // ONLY ever spawn the USER-scope entry. A project-scope `.mcp.json` is
  // attacker-controllable (any repo a human points Session Manager at) and
  // Claude Code deliberately gates running it behind the human's own
  // enabledMcpjsonServers/enableAllProjectMcpServers approval — a gate this
  // probe has no way to check. checkDelegationReadiness runs unattended
  // (New Epic banner on mount, session_manager_help), so falling back to a
  // project-scope command here would let a malicious repo's .mcp.json get
  // executed the moment its cwd is merely probed, bypassing that approval
  // entirely. Auto-approving project-scope servers is explicitly out of
  // scope for this probe — see this PRD's "Out of scope".
  const userConfig = readJsonSafe(path.join(homeDir, '.claude.json'), null);
  const entry = userConfig?.mcpServers?.[SCHEDULER_MCP_NAME];

  if (!entry?.command) {
    return { ...base, ok: true, skipped: true, detail: 'skipped — no user-scope registration to safely run (a project-scope-only .mcp.json entry is not auto-executed)', fix: null };
  }

  const command = entry.command;
  const args = Array.isArray(entry.args) ? entry.args : [];
  const env = entry.env && typeof entry.env === 'object' ? entry.env : {};

  const result = await probeSchedulerMcpLiveMemoized({ command, args, env });
  return {
    ...base,
    ok: result.ok,
    detail: result.detail,
    fix: result.ok
      ? null
      : `Run \`${command} ${args.join(' ')}\` by hand in a fresh shell to see the startup error directly, or \`claude mcp get ${SCHEDULER_MCP_NAME}\``,
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
 * Runs all six delegation-readiness checks for `cwd`. Every filesystem read
 * is wrapped (readJsonSafe / try-catch) so a missing or unparseable file
 * yields ok:false with a detail, never a thrown exception. Async because
 * scheduler-mcp-live genuinely spawns a process and waits on it (bounded by
 * LIVE_PROBE_TIMEOUT_MS, and memoized per registration signature so repeat
 * callers — the New Epic banner, session_manager_help — don't each pay for
 * a fresh spawn).
 */
async function checkDelegationReadiness({ cwd, homeDir = os.homedir() }) {
  const schedulerMcpCheck = checkSchedulerMcp({ cwd, homeDir });
  const schedulerMcpLiveCheck = await checkSchedulerMcpLive({ cwd, homeDir, schedulerMcpCheck });

  // `fixAction: null` / `warn: false` are the defaults — only a check with a
  // sanctioned one-press installer overrides fixAction (today: prd-write-guard),
  // and only scheduler-mcp-project-duplicate ever sets warn.
  const checks = [
    schedulerMcpCheck,
    schedulerMcpLiveCheck,
    checkSchedulerMcpProjectDuplicate({ cwd, homeDir }),
    checkDevPlugin({ homeDir }),
    checkAgentPersonas({ cwd, homeDir }),
    checkPrdWriteGuard({ cwd }),
  ].map((c) => ({ fixAction: null, warn: false, ...c }));

  return {
    ok: checks.every((c) => c.ok),
    checks,
  };
}

module.exports = {
  checkDelegationReadiness,
  installPrdWriteGuard,
  probeSchedulerMcpLive,
  clearLiveProbeCache,
  PRD_WRITE_GUARD_SCRIPT,
  PRD_WRITE_GUARD_MATCHER,
};

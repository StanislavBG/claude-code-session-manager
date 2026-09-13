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
const { shimPath: guardShimPath, resolveShimTarget, ensureGuardShimsOrError } = require('./guardShims.cjs');
const { resolveProjectRoot } = require('./opsOwnership.cjs');

const SCHEDULER_MCP_NAME = 'session-manager-scheduler';
const DEV_PLUGIN_ENABLED_KEY = 'session-manager-dev@session-manager';
const SCHEDULER_MCP_SERVER_SCRIPT = path.resolve(__dirname, '..', '..', '..', 'scripts', 'scheduler-mcp-server.cjs');
const PRD_WRITE_GUARD_SCRIPT = path.resolve(__dirname, '..', '..', '..', 'scripts', 'hooks', 'guard-prd-writes.cjs');
const PRD_WRITE_GUARD_MATCHER = 'Write|Edit|NotebookEdit';
const DESTRUCTIVE_GIT_GUARD_SCRIPT = path.resolve(__dirname, '..', '..', '..', 'scripts', 'hooks', 'guard-destructive-git.cjs');
const DESTRUCTIVE_GIT_GUARD_MATCHER = 'Bash';
const INLINE_IMPLEMENTATION_GUARD_SCRIPT = path.resolve(__dirname, '..', '..', '..', 'scripts', 'hooks', 'guard-inline-implementation.cjs');
const INLINE_IMPLEMENTATION_GUARD_MATCHER = 'Write|Edit|NotebookEdit';
const SELF_SCHEDULE_GUARD_SCRIPT = path.resolve(__dirname, '..', '..', '..', 'scripts', 'hooks', 'guard-self-schedule.cjs');
const SELF_SCHEDULE_GUARD_MATCHER = 'ScheduleWakeup|CronCreate|Task|Agent';
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
 * Pull a guard script's path out of a hook `command` string.
 *
 * Commands are `node <script>` (optionally quoted). `scriptBasename` names
 * the exact guard file we're looking for — anything else is not that hook.
 */
function extractGuardScriptPath(command, scriptBasename) {
  const esc = scriptBasename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?:"([^"]*${esc})"|'([^']*${esc})'|(\\S*${esc}))`);
  const match = String(command).match(re);
  if (!match) return null;
  return match[1] || match[2] || match[3] || null;
}

/**
 * Per-guard config for the three sanctioned PreToolUse guards. `checkGuard`/
 * `installGuard` below are the ONE implementation of the "resolve the hook
 * command's script, validate a stable shim's pointer, merge/repair into
 * .claude/settings.json" logic that used to be copy-pasted three times (one
 * per guard) — a change to that logic (e.g. a new decay case) used to need
 * three edits kept in lockstep by hand. `checkPrdWriteGuard`/`installPrdWriteGuard`/
 * etc. below are thin, name-preserving wrappers so every existing caller/test/
 * export keeps working unchanged.
 */
const GUARD_DEFS = {
  prdWrite: {
    id: 'prd-write-guard',
    label: 'PRD-write guard hook installed',
    guardName: 'guard-prd-writes',
    scriptBasename: 'guard-prd-writes.cjs',
    script: PRD_WRITE_GUARD_SCRIPT,
    matcher: PRD_WRITE_GUARD_MATCHER,
    fixActionId: 'install-prd-write-guard',
    nudge: false,
  },
  destructiveGit: {
    id: 'destructive-git-guard',
    label: 'Destructive-git guard hook installed',
    guardName: 'guard-destructive-git',
    scriptBasename: 'guard-destructive-git.cjs',
    script: DESTRUCTIVE_GIT_GUARD_SCRIPT,
    matcher: DESTRUCTIVE_GIT_GUARD_MATCHER,
    fixActionId: 'install-destructive-git-guard',
    nudge: false,
  },
  inlineImplementation: {
    id: 'inline-implementation-guard',
    label: 'Inline-implementation guard hook installed',
    guardName: 'guard-inline-implementation',
    scriptBasename: 'guard-inline-implementation.cjs',
    script: INLINE_IMPLEMENTATION_GUARD_SCRIPT,
    matcher: INLINE_IMPLEMENTATION_GUARD_MATCHER,
    fixActionId: 'install-inline-implementation-guard',
    // Deliberately a NUDGE that fails OPEN twice over (see
    // guard-inline-implementation.cjs's header), not an ownership law like
    // guard-prd-writes — label/detail/fix text must not imply a hard gate.
    nudge: true,
  },
  selfSchedule: {
    id: 'self-schedule-guard',
    label: 'Self-schedule guard hook installed',
    guardName: 'guard-self-schedule',
    scriptBasename: 'guard-self-schedule.cjs',
    script: SELF_SCHEDULE_GUARD_SCRIPT,
    matcher: SELF_SCHEDULE_GUARD_MATCHER,
    fixActionId: 'install-self-schedule-guard',
    nudge: false,
  },
};

/**
 * `ok` must mean "a hook that will actually run", not "the settings file
 * mentions this guard somewhere".
 *
 * The failure mode this guards against: a PreToolUse command that exits
 * non-zero WITHOUT exit code 2 is a non-blocking error, so a hook pointing at
 * a script that doesn't exist in this project silently guards nothing — while
 * a substring match would flip this check green. That is strictly worse than
 * an honest red. So we resolve the command's script path (relative resolves
 * against the project cwd, which is what the harness runs the hook with),
 * require the file to exist on disk, AND — when that file is itself a stable
 * shim (guardShims.cjs), require its pointer to resolve to a real script too.
 * Without that second step, a shim whose `app-root.json` has decayed (moved
 * repo, hand-edited, deleted) would report green forever: the shim FILE never
 * moves, only its pointer does — this is the same "silently guards nothing
 * while reporting green" failure mode, one hop downstream of the hook command.
 */
function checkGuard(def, { cwd, homeDir = os.homedir() }) {
  const settings = readJsonSafe(path.join(cwd, '.claude', 'settings.json'), null);
  const preToolUse = Array.isArray(settings?.hooks?.PreToolUse) ? settings.hooks.PreToolUse : [];

  let mentioned = false;
  let resolvedScript = null;
  let decayError = null;
  for (const matcher of preToolUse) {
    if (!Array.isArray(matcher?.hooks)) continue;
    for (const h of matcher.hooks) {
      if (typeof h?.command !== 'string' || !h.command.includes(def.guardName)) continue;
      mentioned = true;
      const raw = extractGuardScriptPath(h.command, def.scriptBasename);
      if (!raw) continue;
      const abs = path.isAbsolute(raw) ? raw : path.resolve(cwd, raw);
      if (!fs.existsSync(abs)) continue;
      try {
        resolveShimTarget(abs); // throws only when `abs` IS a shim with a decayed pointer
        resolvedScript = abs;
        break;
      } catch (err) {
        decayError = err.message;
      }
    }
    if (resolvedScript) break;
  }

  const ok = !!resolvedScript;
  let detail;
  if (ok) detail = `${def.guardName} PreToolUse hook found in ${cwd}/.claude/settings.json, resolving to ${resolvedScript}`;
  else if (decayError) detail = `${def.guardName} PreToolUse hook in ${cwd}/.claude/settings.json points at a stable shim whose pointer has decayed — it would silently guard nothing: ${decayError}`;
  else if (mentioned) detail = `${def.guardName} PreToolUse hook in ${cwd}/.claude/settings.json names a script that does not exist — it would silently guard nothing`;
  else detail = `no ${def.guardName} PreToolUse hook in ${cwd}/.claude/settings.json${def.nudge ? ' — this is a nudge, not a hard gate' : ''}`;

  return {
    id: def.id,
    label: def.label,
    ok,
    detail,
    fix: ok
      ? null
      : `Add a PreToolUse hook to ${cwd}/.claude/settings.json matching ${def.matcher} that runs node ${guardShimPath(def.scriptBasename, homeDir)}${def.nudge ? ' (a nudge, not a hard gate)' : ''}`,
    fixAction: ok ? null : def.fixActionId,
  };
}

/**
 * Install `def`'s guard into `<cwd>/.claude/settings.json`.
 *
 * ── The standardized approach is REFERENCE, not vendor ────────────────────
 * The hook command points at session-manager's own copy of the guard script
 * by ABSOLUTE path (via the stable shim, see below). We deliberately do NOT
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
 * — is closed by checkGuard() above, which resolves the command's script path
 * and fails the check when the file is gone.
 *
 * Merges into any existing hooks block rather than clobbering it: other
 * PreToolUse matchers, other hooks under the same matcher, and every unrelated
 * settings key are preserved. Idempotent — a healthy guard is a no-op, and a
 * guard entry pointing at a missing script is repaired in place. Two guards
 * sharing the same matcher string (prd-write and inline-implementation both
 * use `Write|Edit|NotebookEdit`) fall into the SAME PreToolUse entry's hooks
 * array automatically — nothing here special-cases that, it falls out of
 * "find the matcher, else push a new one".
 *
 * ── Stable shim, not the raw app path ─────────────────────────────────────
 * The hook command written below points at
 * `~/.claude/session-manager/hooks/<guard>.cjs` (guardShims.cjs), a tiny shim
 * that re-requires the real script through a pointer file rewritten on every
 * boot — not at `def.script` directly. Run via
 * `npx claude-code-session-manager@latest`, `def.script` resolves under an
 * ephemeral `~/.npm/_npx/<hash>/...` directory that the next `npx ...@latest`
 * or npm cache prune deletes — the shim survives every app upgrade because
 * only its pointer file changes, never its own path.
 */
async function installGuard(def, { cwd, homeDir = os.homedir(), skipShimEnsure = false }) {
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
  if (!fs.existsSync(def.script)) {
    // Writing a hook that points at a script that doesn't exist would report
    // installed while silently guarding nothing (a non-zero-without-2 exit is
    // a non-blocking error to the harness) — refuse instead of lying.
    return { ok: false, action: 'error', error: `${def.script} does not exist — cannot install a guard hook that points at a missing script` };
  }
  // Same refusal principle as above: never write a hook command pointing at
  // a shim that does not exist on disk. Skipped when the caller (installAllGuards)
  // already ensured it once for this whole pass — see that function's comment.
  if (!skipShimEnsure) {
    const shimError = await ensureGuardShimsOrError(homeDir);
    if (shimError) return shimError;
  }
  const settings = (existing && typeof existing === 'object' && !Array.isArray(existing)) ? existing : {};

  const command = `node ${guardShimPath(def.scriptBasename, homeDir)}`;
  const hooks = (settings.hooks && typeof settings.hooks === 'object') ? settings.hooks : {};
  const preToolUse = Array.isArray(hooks.PreToolUse) ? hooks.PreToolUse.slice() : [];

  // Already healthy? Nothing to do.
  if (checkGuard(def, { cwd, homeDir }).ok) {
    return { ok: true, action: 'already-installed', settingsPath, command };
  }

  // Repair a broken entry in place, wherever it sits, before appending.
  let repaired = false;
  for (const matcher of preToolUse) {
    if (!Array.isArray(matcher?.hooks)) continue;
    for (const h of matcher.hooks) {
      if (typeof h?.command === 'string' && h.command.includes(def.guardName)) {
        h.command = command;
        h.type = 'command';
        repaired = true;
      }
    }
  }

  if (!repaired) {
    const target = preToolUse.find((m) => m?.matcher === def.matcher);
    if (target) {
      target.hooks = Array.isArray(target.hooks) ? target.hooks : [];
      target.hooks.push({ type: 'command', command });
    } else {
      preToolUse.push({ matcher: def.matcher, hooks: [{ type: 'command', command }] });
    }
  }

  const next = { ...settings, hooks: { ...hooks, PreToolUse: preToolUse } };
  await writeJson(settingsPath, next);

  return { ok: true, action: repaired ? 'repaired' : 'installed', settingsPath, command };
}

function checkPrdWriteGuard({ cwd, homeDir = os.homedir() } = {}) {
  return checkGuard(GUARD_DEFS.prdWrite, { cwd, homeDir });
}

async function installPrdWriteGuard({ cwd, homeDir = os.homedir(), skipShimEnsure = false } = {}) {
  return installGuard(GUARD_DEFS.prdWrite, { cwd, homeDir, skipShimEnsure });
}

function checkDestructiveGitGuard({ cwd, homeDir = os.homedir() } = {}) {
  return checkGuard(GUARD_DEFS.destructiveGit, { cwd, homeDir });
}

async function installDestructiveGitGuard({ cwd, homeDir = os.homedir(), skipShimEnsure = false } = {}) {
  return installGuard(GUARD_DEFS.destructiveGit, { cwd, homeDir, skipShimEnsure });
}

function checkInlineImplementationGuard({ cwd, homeDir = os.homedir() } = {}) {
  return checkGuard(GUARD_DEFS.inlineImplementation, { cwd, homeDir });
}

async function installInlineImplementationGuard({ cwd, homeDir = os.homedir(), skipShimEnsure = false } = {}) {
  return installGuard(GUARD_DEFS.inlineImplementation, { cwd, homeDir, skipShimEnsure });
}

function checkSelfScheduleGuard({ cwd, homeDir = os.homedir() } = {}) {
  return checkGuard(GUARD_DEFS.selfSchedule, { cwd, homeDir });
}

async function installSelfScheduleGuard({ cwd, homeDir = os.homedir(), skipShimEnsure = false } = {}) {
  return installGuard(GUARD_DEFS.selfSchedule, { cwd, homeDir, skipShimEnsure });
}

/**
 * Runs all eight delegation-readiness checks for `cwd`. Every filesystem read
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
  // sanctioned one-press installer overrides fixAction (today: prd-write-guard,
  // destructive-git-guard), and only scheduler-mcp-project-duplicate ever sets warn.
  const checks = [
    schedulerMcpCheck,
    schedulerMcpLiveCheck,
    checkSchedulerMcpProjectDuplicate({ cwd, homeDir }),
    checkDevPlugin({ homeDir }),
    checkAgentPersonas({ cwd, homeDir }),
    checkPrdWriteGuard({ cwd, homeDir }),
    checkDestructiveGitGuard({ cwd, homeDir }),
    checkInlineImplementationGuard({ cwd, homeDir }),
    checkSelfScheduleGuard({ cwd, homeDir }),
  ].map((c) => ({ fixAction: null, warn: false, ...c }));

  return {
    ok: checks.every((c) => c.ok),
    checks,
  };
}

/**
 * Every auto-install attempt is logged from HERE, not just the manual
 * Fix-It path in index.cjs's logGuardInstallAttempt — `scope: 'delegationReadiness'`
 * is the distinct vocabulary this PRD's acceptance criteria names, so an
 * auto-heal is never confused with a human pressing Fix It
 * (scope: 'delegationReadinessGuardInstall'). Never throws — a logging
 * failure must not prevent the guard install it's reporting on.
 */
function logAutoInstallEvent({ cwd, guard, action, error }) {
  try {
    const opsErrorLog = require('./opsErrorLog.cjs');
    opsErrorLog.appendError({
      cwd,
      scope: 'delegationReadiness',
      level: action === 'error' ? 'error' : 'info',
      message: `auto-install ${guard}: ${action}`,
      meta: { guard, action, ...(error ? { error } : {}) },
    });
  } catch { /* logging must never break the caller */ }
}

const GUARDS = [
  { id: 'prd-write-guard', install: installPrdWriteGuard },
  { id: 'destructive-git-guard', install: installDestructiveGitGuard },
  { id: 'inline-implementation-guard', install: installInlineImplementationGuard },
  { id: 'self-schedule-guard', install: installSelfScheduleGuard },
];

// resolved project root -> Promise<{ ok, root, guards }>, kept for the app's
// whole lifetime — a project that already passed all three guard checks
// once never gets re-probed/re-written on a later cwd-change/keystroke.
const guardsInstalledCache = new Map();

/** Test-only: forces the next ensureGuardsInstalled call to actually run. */
function clearGuardsInstalledCache() {
  guardsInstalledCache.clear();
}

async function installAllGuards(root, homeDir) {
  // Ensure the shim pointer + all three shims ONCE per pass, up front, rather
  // than once per guard below — each install*Guard rewrites the SAME pointer
  // file + shim files via writeTextAtomic (no content-equality skip), so
  // calling it 3x here was 3x the atomic writes for identical content. The
  // per-guard installers still ensure it themselves when called individually
  // (the manual "Fix it" path installs one guard at a time and never goes
  // through installAllGuards), and this call still refreshes the pointer to
  // the current app root exactly as before an app upgrade requires.
  const shimError = await ensureGuardShimsOrError(homeDir);
  const guards = {};
  for (const { id, install } of GUARDS) {
    let outcome;
    try {
      outcome = shimError ? shimError : await install({ cwd: root, homeDir, skipShimEnsure: true });
    } catch (err) {
      outcome = { ok: false, action: 'error', error: err?.message ?? String(err) };
    }
    guards[id] = outcome;
    logAutoInstallEvent({
      cwd: root,
      guard: id,
      action: outcome.ok ? outcome.action : 'error',
      error: outcome.ok ? undefined : outcome.error,
    });
  }
  return { ok: Object.values(guards).every((g) => g.ok), root, guards };
}

/**
 * Silently, idempotently installs the three sanctioned guards for whatever
 * real project `cwd` belongs to — the fix for "Fix It is the only call site,
 * so every project starts red forever." Never throws (every failure mode —
 * a bad/ephemeral/nonexistent cwd, an unwritable project, malformed JSON —
 * resolves to a logged, ok:false outcome instead), so it is always safe to
 * `await` directly in front of checkDelegationReadiness.
 *
 * `cwd` is resolved to its real project root via opsOwnership's
 * resolveProjectRoot (same normalization the ops-write path already trusts)
 * BEFORE anything is cached or written, so a job/Epic worktree cwd installs
 * into the actual project's `.claude/settings.json`, never a copy that gets
 * deleted with the worktree.
 */
async function ensureGuardsInstalled(cwd, { homeDir = os.homedir() } = {}) {
  let root;
  try {
    root = resolveProjectRoot(cwd);
  } catch (err) {
    logAutoInstallEvent({ cwd, guard: 'project-root', action: 'error', error: err?.message ?? String(err) });
    return { ok: false, root: null, guards: {}, error: err?.message ?? String(err) };
  }

  const cacheKey = `${root} ${homeDir}`;
  const cached = guardsInstalledCache.get(cacheKey);
  if (cached) return cached;

  // A deleted/renamed project folder must never come back to life as a
  // side effect of probing it — installPrdWriteGuard/etc. happily
  // `mkdir -p` their target, which would otherwise resurrect a phantom
  // `<root>/.claude/` for a project that no longer exists on disk. Refuse
  // before any write is attempted, and log via console (not the ops error
  // log — there is no legitimate ops root left to write into).
  let rootStat;
  try {
    rootStat = fs.statSync(root);
  } catch {
    rootStat = null;
  }
  if (!rootStat || !rootStat.isDirectory()) {
    const message = `project root does not exist on disk: ${root}`;
    console.warn(`[delegationReadiness] ensureGuardsInstalled: ${message}`);
    // Not cached — same "only a success is worth remembering" rule as the
    // installAllGuards path below, so a worktree that hasn't materialized
    // yet (or a project folder restored after a delete) gets retried on the
    // next probe instead of being permanently marked ok:false.
    return { ok: false, root, guards: {}, error: message };
  }

  const promise = installAllGuards(root, homeDir).then((result) => {
    // The cache's whole purpose (see the comment above guardsInstalledCache)
    // is to skip re-probing a project that already SUCCEEDED — not to lock in
    // a failed first attempt (malformed settings.json, a transient write
    // error) so the automatic self-heal can never retry even after the
    // underlying problem is fixed. installAllGuards never throws for an
    // ordinary per-guard failure (see its own try/catch), so this ok:false
    // path — not the .catch below — is the one that actually fires for the
    // realistic failure modes; only a genuine success is worth remembering
    // for the app's lifetime.
    if (!result.ok) guardsInstalledCache.delete(cacheKey);
    return result;
  }).catch((err) => {
    guardsInstalledCache.delete(cacheKey); // don't poison the cache on an unexpected throw
    const message = err?.message ?? String(err);
    logAutoInstallEvent({ cwd: root, guard: 'ensure-guards-installed', action: 'error', error: message });
    return { ok: false, root, guards: {}, error: message };
  });
  guardsInstalledCache.set(cacheKey, promise);
  return promise;
}

module.exports = {
  checkDelegationReadiness,
  ensureGuardsInstalled,
  clearGuardsInstalledCache,
  installPrdWriteGuard,
  installDestructiveGitGuard,
  installInlineImplementationGuard,
  installSelfScheduleGuard,
  probeSchedulerMcpLive,
  clearLiveProbeCache,
  PRD_WRITE_GUARD_SCRIPT,
  PRD_WRITE_GUARD_MATCHER,
  DESTRUCTIVE_GIT_GUARD_SCRIPT,
  DESTRUCTIVE_GIT_GUARD_MATCHER,
  INLINE_IMPLEMENTATION_GUARD_SCRIPT,
  INLINE_IMPLEMENTATION_GUARD_MATCHER,
  SELF_SCHEDULE_GUARD_SCRIPT,
  SELF_SCHEDULE_GUARD_MATCHER,
};

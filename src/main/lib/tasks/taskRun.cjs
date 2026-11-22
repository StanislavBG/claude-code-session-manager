'use strict';

/**
 * taskRun.cjs — run ONE headless `claude -p` for a Task.
 *
 * The Task primitive's spawn half. Explicit --model and --effort, the caller's
 * runtime flags passed through unchanged, the prompt on stdin (never argv —
 * E2BIG), and a structured result: exit, stdout, parsed JSON envelope, usage
 * and quota state.
 *
 * Deliberately NOT here:
 *  - slot acquisition (lib/scheduler/sessionSlots.cjs) — the route holds the slot;
 *  - a persona body — `--system-prompt` is passed only when the caller gives one,
 *    and it REPLACES the system prompt (never --append-system-prompt);
 *  - ledger writes / HTTP.
 *
 * Spawn pattern mirrors lib/claude/runClaudeP.cjs (resolveClaudeBin,
 * claudeSpawnTarget, feedChildStdin) inside a memory scope like chatRunner.cjs.
 */

const path = require('node:path');
const os = require('node:os');
const { spawn: nodeSpawn } = require('node:child_process');
const { resolveClaudeBin, claudeSpawnTarget } = require('../claude/claudeBin.cjs');
const { headlessPermissionArgs, ensureCliCapsProbed } = require('../claude/claudeCliCaps.cjs');
const { detectRateLimitInText } = require('../claude/rateLimitDetect.cjs');
const { feedChildStdin } = require('../process/childStdin.cjs');
const { withProcRole } = require('../process/cleanEnv.cjs');
const { killTree, detachedSpawnOpts } = require('../process/killTree.cjs');
const memoryScope = require('../process/memoryScope.cjs');
const { writeToolRiskGuardSettingsFile } = require('../epic/guardSpawnSettings.cjs');

const MAX_STDOUT_BYTES = 8 * 1024 * 1024;
const STDERR_TAIL_BYTES = 16 * 1024;
const MAX_ARG_BYTES = 100 * 1024;
const PROC_ROLE = 'aux';
const PROC_DETAIL = 'task';

function nonEmptyString(v) {
  return typeof v === 'string' && v.trim() !== '';
}

/**
 * Build the claude argv for a Task. Pure (reads only the cached CLI-caps probe
 * via headlessPermissionArgs()). Never includes the prompt.
 *
 * @param {{ model: string, effort: string, runtime?: Record<string, any>, projectCwd?: string }} o
 * @returns {string[]}
 */
function buildTaskArgs({ model, effort, runtime, projectCwd } = /** @type {any} */ ({})) {
  if (!nonEmptyString(model)) throw new Error('buildTaskArgs: model is required');
  if (!nonEmptyString(effort)) throw new Error('buildTaskArgs: effort is required');
  const rt = runtime && typeof runtime === 'object' ? runtime : {};
  const base = typeof projectCwd === 'string' && projectCwd ? projectCwd : process.cwd();

  const args = ['-p', '--model', model, '--effort', effort];
  if (nonEmptyString(rt.sessionId)) args.push('--session-id', rt.sessionId);
  if (nonEmptyString(rt.resume)) args.push('--resume', rt.resume);
  if (!(rt.persistSession === true || nonEmptyString(rt.resume))) args.push('--no-session-persistence');
  if (typeof rt.settingSources === 'string') args.push('--setting-sources', rt.settingSources);
  if (rt.strictMcpConfig === true) args.push('--strict-mcp-config');
  if (rt.maxTurns !== undefined && rt.maxTurns !== null) args.push('--max-turns', String(rt.maxTurns));
  if (typeof rt.systemPrompt === 'string') args.push('--system-prompt', rt.systemPrompt);
  if (rt.dangerouslySkipPermissions === true) args.push('--dangerously-skip-permissions', ...headlessPermissionArgs());

  // Variadic flags last-but-one: a following flag (--output-format) always ends their list.
  const mcp = rt.mcpConfig === undefined || rt.mcpConfig === null
    ? null
    : (Array.isArray(rt.mcpConfig) ? rt.mcpConfig : [rt.mcpConfig]);
  if (mcp && mcp.length) args.push('--mcp-config', ...mcp.map((p) => path.resolve(base, String(p))));
  if (Array.isArray(rt.allowedTools)) args.push('--allowedTools', rt.allowedTools.join(','));
  if (Array.isArray(rt.tools)) args.push('--tools', rt.tools.join(','));

  if (rt.outputFormat === 'stream-json') args.push('--output-format', 'stream-json', '--verbose');
  else args.push('--output-format', 'json');

  for (const a of args) {
    if (Buffer.byteLength(a, 'utf8') > MAX_ARG_BYTES) {
      const err = /** @type {Error & { code?: string }} */ (new Error(`buildTaskArgs: an argv element exceeds ${MAX_ARG_BYTES} bytes`));
      err.code = 'argv_too_large';
      throw err;
    }
  }
  return args;
}

/**
 * baseEnv + the three Task markers. No other caller env is ever added.
 * @param {Record<string, any>} runtime
 * @param {Record<string, string|undefined>} baseEnv
 */
function buildTaskEnv(runtime, baseEnv) {
  const env = withProcRole({ ...(baseEnv || {}), SM_KG_INTERNAL: '1' }, PROC_ROLE);
  if (runtime && runtime.disableAutoMemory === true) env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1';
  return env;
}

/**
 * Load guard-tool-risk into a Task run: '--settings', <path> right after '-p'
 * (ahead of every variadic flag) and SM_TOOL_RISK_HEADLESS='1' (no clearance —
 * a Task has no PRD riskTools). A null path returns the inputs unchanged.
 * Pure: never mutates args/env.
 *
 * @param {{ args: string[], env: Record<string, string|undefined>, settingsPath: string|null }} o
 */
function withToolRiskGuard({ args, env, settingsPath }) {
  if (typeof settingsPath !== 'string' || !settingsPath) return { args, env };
  const a = Array.isArray(args) ? args.slice() : [];
  const at = a[0] === '-p' ? 1 : 0;
  a.splice(at, 0, '--settings', settingsPath);
  return { args: a, env: { ...(env || {}), SM_TOOL_RISK_HEADLESS: '1' } };
}

/** Parse json stdout, or the last stream-json `type: 'result'` line. */
function parseEnvelope(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return null;
  try {
    const v = JSON.parse(text);
    if (v && typeof v === 'object' && !Array.isArray(v)) return v;
    if (Array.isArray(v)) {
      for (let i = v.length - 1; i >= 0; i--) if (v[i] && v[i].type === 'result') return v[i];
    }
  } catch { /* stream-json: fall through */ }
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i].trim();
    if (!t || t[0] !== '{') continue;
    try {
      const ev = JSON.parse(t);
      if (ev && ev.type === 'result') return ev;
    } catch { /* partial line */ }
  }
  return null;
}

/** resetsAt of the last rejected rate_limit_event, as an ISO string, else null. */
function parseResetsAt(stdout) {
  let out = null;
  for (const line of String(stdout || '').split('\n')) {
    const t = line.trim();
    if (!t || t[0] !== '{') continue;
    let ev;
    try { ev = JSON.parse(t); } catch { continue; }
    if (!ev || ev.type !== 'rate_limit_event' || !ev.rate_limit_info) continue;
    if (ev.rate_limit_info.status !== 'rejected') continue;
    const r = Number(ev.rate_limit_info.resetsAt);
    if (Number.isFinite(r) && r > 0) out = new Date(r < 1e12 ? r * 1000 : r).toISOString();
  }
  return out;
}

/** Text form of an envelope for callers that want `--output-format text` stdout. */
function textStdoutFor(envelope) {
  const r = envelope && typeof envelope.result === 'string' ? envelope.result : '';
  return `${r}\n`;
}

/**
 * Spawn claude, feed the prompt on stdin, capture. Resolves — never throws.
 *
 * @param {{ args: string[], env: Record<string, string|undefined>, prompt: string, cwd: string,
 *   timeoutMs?: number, signal?: AbortSignal, onSpawn?: (pid: number) => void }} o
 */
async function runTask({ args, env, prompt, cwd, timeoutMs = 600_000, signal, onSpawn, deps = {} } = /** @type {any} */ ({})) {
  const startedAt = Date.now();
  const base = () => ({
    status: /** @type {string} */ ('spawn_failed'),
    exitCode: null,
    signal: null,
    stdout: '',
    stderrTail: '',
    envelope: null,
    usage: null,
    modelUsage: null,
    cliCostUsd: null,
    numTurns: null,
    sessionId: null,
    durationMs: 0,
    quota: { rateLimited: false, resetsAt: null },
  });
  try { await ensureCliCapsProbed(); } catch { /* probe is best effort */ }
  if (signal && signal.aborted) return { ...base(), status: 'caller_gone', durationMs: Date.now() - startedAt };

  // guard-tool-risk (PRD scheduler-tool-risk-wiring): a null settings path
  // never blocks the run — log one line and spawn without it.
  const writeRiskSettings = deps.writeToolRiskGuardSettingsFile || writeToolRiskGuardSettingsFile;
  let settingsPath = null;
  try { settingsPath = await writeRiskSettings({ homeDir: os.homedir() }); } catch { settingsPath = null; }
  if (!settingsPath) console.warn('[taskRun] tool-risk guard settings unavailable; running the Task without guard-tool-risk');
  ({ args, env } = withToolRiskGuard({ args, env, settingsPath }));

  return new Promise((resolve) => {
    let settled = false;
    let child = null;
    let timer = null;
    let onAbort = null;
    let killedFor = null; // 'timeout' | 'caller_gone'
    let stdout = '';
    let stdoutBytes = 0;
    let stderrTail = '';

    const finish = (r) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (signal && onAbort) { try { signal.removeEventListener('abort', onAbort); } catch { /* */ } }
      resolve({ ...r, durationMs: Date.now() - startedAt });
    };
    const kill = (why) => {
      if (killedFor || !child) return;
      killedFor = why;
      if (!killTree(child.pid, 'SIGKILL')) { try { child.kill('SIGKILL'); } catch { /* already dead */ } }
    };

    try {
      const bin = resolveClaudeBin();
      let target = claudeSpawnTarget(PROC_ROLE, PROC_DETAIL, bin, args);
      let spawnArgs = target.args || args;
      const limits = memoryScope.memoryLimitsFor({ totalRamMb: Math.floor(os.totalmem() / 1048576) });
      if (limits && memoryScope.scopeSupported()) {
        const unit = `sm-task-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
        const wrapped = memoryScope.wrapInMemoryScope({ command: target.command, args: spawnArgs, unit, limits });
        // argv0 cannot pass through systemd-run — dropped on the wrapped path only.
        target = { ...target, command: wrapped.command, argv0: undefined };
        spawnArgs = wrapped.args;
      }
      child = nodeSpawn(target.command, spawnArgs, {
        cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        ...(target.argv0 ? { argv0: target.argv0 } : {}),
        ...(target.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
        ...detachedSpawnOpts(),
      });
    } catch (e) {
      finish({ ...base(), status: 'spawn_failed', stderrTail: String((e && e.message) || e) });
      return;
    }

    child.on('error', (e) => {
      // Spawn-time failure (ENOENT, EACCES): no 'close' with a real exit follows reliably.
      if (child.pid === undefined || child.exitCode === null) {
        finish({ ...base(), status: 'spawn_failed', stdout, stderrTail: (stderrTail + String((e && e.message) || e)).slice(-STDERR_TAIL_BYTES) });
      }
    });

    if (child.pid !== undefined) {
      try { if (typeof onSpawn === 'function') onSpawn(child.pid); } catch { /* caller hook must not break the run */ }
    }

    child.stdout.on('data', (d) => {
      if (stdoutBytes >= MAX_STDOUT_BYTES) return;
      const room = MAX_STDOUT_BYTES - stdoutBytes;
      const buf = Buffer.isBuffer(d) ? d : Buffer.from(String(d));
      const take = buf.length > room ? buf.subarray(0, room) : buf;
      stdout += take.toString('utf8');
      stdoutBytes += take.length;
    });
    child.stderr.on('data', (d) => {
      stderrTail += String(d);
      if (stderrTail.length > STDERR_TAIL_BYTES) stderrTail = stderrTail.slice(-STDERR_TAIL_BYTES);
    });

    feedChildStdin(child, String(prompt == null ? '' : prompt));

    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timer = setTimeout(() => kill('timeout'), timeoutMs);
    }
    if (signal) {
      onAbort = () => kill('caller_gone');
      signal.addEventListener('abort', onAbort, { once: true });
    }

    child.on('close', (code, sig) => {
      const envelope = parseEnvelope(stdout);
      const rateLimited = detectRateLimitInText(stdout)
        || (envelope ? detectRateLimitInText(JSON.stringify(envelope)) : false);
      let status;
      if (killedFor) status = killedFor;
      else if (rateLimited) status = 'rate_limited';
      else if (code !== 0 || (envelope && envelope.is_error === true) || sig) status = 'error';
      else status = 'ok';
      finish({
        status,
        exitCode: typeof code === 'number' ? code : null,
        signal: sig || null,
        stdout,
        stderrTail,
        envelope,
        usage: (envelope && envelope.usage) || null,
        modelUsage: (envelope && envelope.modelUsage) || null,
        cliCostUsd: envelope && typeof envelope.total_cost_usd === 'number' ? envelope.total_cost_usd : null,
        numTurns: envelope && typeof envelope.num_turns === 'number' ? envelope.num_turns : null,
        sessionId: (envelope && typeof envelope.session_id === 'string' && envelope.session_id) || null,
        durationMs: 0,
        quota: { rateLimited, resetsAt: rateLimited ? parseResetsAt(stdout) : null },
      });
    });
  });
}

module.exports = { buildTaskArgs, buildTaskEnv, withToolRiskGuard, runTask, textStdoutFor, parseEnvelope, MAX_STDOUT_BYTES, STDERR_TAIL_BYTES, MAX_ARG_BYTES };

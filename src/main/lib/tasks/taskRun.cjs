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
 *  - a persona body — never added. `--system-prompt` is passed only when the
 *    caller gives one, and it REPLACES the system prompt; `--append-system-prompt`
 *    carries only the caller's runtime.appendSystemPrompt;
 *  - ledger writes / HTTP.
 *
 * Spawn pattern mirrors lib/claude/runClaudeP.cjs (resolveClaudeBin,
 * claudeSpawnTarget, feedChildStdin) inside a memory scope like chatRunner.cjs.
 */

const nodeFs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn: nodeSpawn } = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');
const { resolveClaudeBin, claudeSpawnTarget } = require('../claude/claudeBin.cjs');
const { headlessPermissionArgs, ensureCliCapsProbed } = require('../claude/claudeCliCaps.cjs');
const { detectRateLimitInText } = require('../claude/rateLimitDetect.cjs');
const { feedChildStdin } = require('../process/childStdin.cjs');
const { withProcRole, stripCredentials, assertNoCredentials } = require('../process/cleanEnv.cjs');
const { killTree, detachedSpawnOpts } = require('../process/killTree.cjs');
const memoryScope = require('../process/memoryScope.cjs');
const { writeToolRiskGuardSettingsFile } = require('../epic/guardSpawnSettings.cjs');
const { buildJobSandboxSettings } = require('../claude/jobSandboxPolicy.cjs');
const { personaToolScopeArgs } = require('../claude/personaToolScope.cjs');
const artifactStore = require('../epic/artifactStore.cjs');

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
 * MCP is always strict: --strict-mcp-config is pushed unconditionally (the
 * CLI then ignores the user/project MCP config), and the only servers loaded
 * inline are the persona's declared `mcpServers:` (`declaredMcpServers`),
 * each resolved in `knownMcpServers` via personaToolScopeArgs. A declared
 * name that resolves nowhere throws { code: 'capability_unknown' } — it never
 * widens to every server. The caller's explicit `runtime.mcpConfig` files are
 * still appended to the same --mcp-config list.
 *
 * runtime.appendSystemPrompt → '--append-system-prompt', <text> right after the
 * --system-prompt pair (single-valued, so never in the variadic block).
 * runtime.disallowedTools (non-empty) → one '--disallowedTools=<rule>' argv
 * element per rule, in order, after --tools. The '=' form is required: after a
 * bare variadic '--disallowedTools' the CLI takes only the first value
 * literally and parses any later value starting with '-' as a NEW flag, so
 * ['X', '--mcp-config', '/x.json'] would inject a flag and drop the deny.
 * Repeated '=' elements accumulate. Rules are never joined: the CLI splits one
 * element on commas and spaces outside parentheses, so one bad rule could
 * swallow the rest. The route has already refused unbalanced rules and rules
 * not starting with a letter.
 *
 * @param {{ model: string, effort: string, runtime?: Record<string, any>, projectCwd?: string,
 *   declaredMcpServers?: readonly string[], knownMcpServers?: Record<string, object> }} o
 * @returns {string[]}
 */
function buildTaskArgs({ model, effort, runtime, projectCwd, declaredMcpServers = [], knownMcpServers = {}, skillDeny = [] } = /** @type {any} */ ({})) {
  if (!nonEmptyString(model)) throw new Error('buildTaskArgs: model is required');
  if (!nonEmptyString(effort)) throw new Error('buildTaskArgs: effort is required');
  const rt = runtime && typeof runtime === 'object' ? runtime : {};
  const base = typeof projectCwd === 'string' && projectCwd ? projectCwd : process.cwd();

  const args = ['-p', '--model', model, '--effort', effort];
  if (nonEmptyString(rt.sessionId)) args.push('--session-id', rt.sessionId);
  if (nonEmptyString(rt.resume)) args.push('--resume', rt.resume);
  if (!(rt.persistSession === true || nonEmptyString(rt.resume))) args.push('--no-session-persistence');
  if (typeof rt.settingSources === 'string') args.push('--setting-sources', rt.settingSources);
  args.push('--strict-mcp-config');
  if (rt.maxTurns !== undefined && rt.maxTurns !== null) args.push('--max-turns', String(rt.maxTurns));
  if (typeof rt.systemPrompt === 'string') args.push('--system-prompt', rt.systemPrompt);
  if (typeof rt.appendSystemPrompt === 'string') args.push('--append-system-prompt', rt.appendSystemPrompt);
  if (rt.dangerouslySkipPermissions === true) {
    // Tool-rules level of the job sandbox policy: bypass kept, home secrets denied.
    // '--settings' takes one value, so it sits here, not in the variadic block below.
    const root = path.resolve(base);
    const policy = buildJobSandboxSettings({
      agentType: 'task', worktreeDir: root, projectRoot: root,
      homeDir: os.homedir(), tmpDir: os.tmpdir(), deps: { available: false, missing: [] },
    });
    args.push(...policy.argv, ...headlessPermissionArgs());
  }

  // Variadic flags last-but-one: a following flag (--output-format) always ends their list.
  const strict = personaToolScopeArgs(null, { mcpServers: knownMcpServers || {}, declaredServers: declaredMcpServers || [] });
  if (strict.refusal) {
    const err = /** @type {Error & { code?: string }} */ (new Error(`buildTaskArgs: declared MCP server '${strict.refusal.name}' is not a known server`));
    err.code = strict.refusal.code;
    throw err;
  }
  const at = strict.args.indexOf('--mcp-config');
  const declaredInline = at === -1 ? [] : [strict.args[at + 1]];
  const mcp = rt.mcpConfig === undefined || rt.mcpConfig === null
    ? []
    : (Array.isArray(rt.mcpConfig) ? rt.mcpConfig : [rt.mcpConfig]);
  const mcpList = [...declaredInline, ...mcp.map((p) => path.resolve(base, String(p)))];
  if (mcpList.length) args.push('--mcp-config', ...mcpList);
  if (Array.isArray(rt.allowedTools)) args.push('--allowedTools', rt.allowedTools.join(','));
  if (Array.isArray(rt.tools)) args.push('--tools', rt.tools.join(','));
  if (Array.isArray(rt.disallowedTools) && rt.disallowedTools.length) {
    for (const rule of rt.disallowedTools) args.push('--disallowedTools=' + String(rule));
  }
  // Skills ride only inside the persona's packs (already '--disallowedTools=Skill(<name>)').
  if (Array.isArray(skillDeny)) args.push(...skillDeny.filter((a) => typeof a === 'string' && a.startsWith('--disallowedTools=Skill(')));

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
 * baseEnv (secret-shaped keys stripped) + the three Task markers. No other
 * caller env is ever added.
 * @param {Record<string, any>} runtime
 * @param {Record<string, string|undefined>} baseEnv
 */
function buildTaskEnv(runtime, baseEnv) {
  const env = withProcRole({ ...stripCredentials(baseEnv), SM_KG_INTERNAL: '1' }, PROC_ROLE);
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

/** ISO resetsAt of one rejected rate_limit_event object, else null (same conversion as parseResetsAt). */
function resetsAtOf(ev) {
  const r = Number(ev && ev.rate_limit_info && ev.rate_limit_info.resetsAt);
  return Number.isFinite(r) && r > 0 ? new Date(r < 1e12 ? r * 1000 : r).toISOString() : null;
}

/** Text form of an envelope for callers that want `--output-format text` stdout. */
function textStdoutFor(envelope) {
  const r = envelope && typeof envelope.result === 'string' ? envelope.result : '';
  return `${r}\n`;
}

/**
 * Spawn claude, feed the prompt on stdin, capture. Resolves — never throws.
 *
 * onStdoutLine(line): called once per complete stdout line, in order ('\n' and a
 * trailing '\r' removed), and once at close for a final unterminated line. It sees
 * every line, including those after the MAX_STDOUT_BYTES capture cap; a single
 * line longer than the cap is delivered truncated to MAX_STDOUT_BYTES. A throwing
 * callback never changes the run's result.
 *
 * Result gains stdoutCapped: true when the cap cut stdout. When capped, the last
 * `type: 'result'` line seen line by line becomes the envelope, and a rejected
 * rate_limit_event seen after the cap still sets quota.rateLimited / resetsAt.
 *
 * @param {{ args: string[], env: Record<string, string|undefined>, prompt: string, cwd: string,
 *   timeoutMs?: number, signal?: AbortSignal, onSpawn?: (pid: number) => void,
 * Artifacts: with a `taskId`, the child gets SM_ARTIFACTS_DIR =
 * artifactStore.stagingDirFor({ runId: taskId }) (outside the repo), and when
 * the run ends that folder is ingested into artifacts/_tasks/<taskId>/ under
 * `projectRoot` (default `cwd`) BEFORE the result resolves. Result gains
 * `artifacts: { published, skipped } | null`. Staging/ingest failures are
 * logged and never change the run's status.
 * The emptied staging folder is then removed (rmdirSync, never recursive); a
 * folder still holding files is kept and logged.
 *
 * @param {{ args: string[], env: Record<string, string|undefined>, prompt: string, cwd: string,
 *   timeoutMs?: number, signal?: AbortSignal, onSpawn?: (pid: number) => void,
 *   onStdoutLine?: (line: string) => void, taskId?: string, projectRoot?: string, deps?: Record<string, any> }} o
 */
async function runTask({ args, env, prompt, cwd, timeoutMs = 600_000, signal, onSpawn, onStdoutLine, taskId, projectRoot, deps = {} } = /** @type {any} */ ({})) {
  const store = deps.artifactStore || artifactStore;
  /** @type {string|null} */
  let artifactsDir = null;
  if (typeof taskId === 'string' && taskId) {
    try { artifactsDir = store.stagingDirFor({ runId: taskId }); } catch (e) {
      console.error('[taskRun] artifact staging dir unavailable', taskId, (e && e.message) || e);
    }
  }
  const result = await spawnTask({ args, env: artifactsDir ? { ...(env || {}), SM_ARTIFACTS_DIR: artifactsDir } : env, prompt, cwd, timeoutMs, signal, onSpawn, onStdoutLine, deps });
  if (!artifactsDir) return { ...result, artifacts: null };
  /** @type {any} */
  let artifacts = null;
  try {
    artifacts = await store.ingestDir({
      projectRoot: projectRoot || cwd, taskId, srcDir: artifactsDir, producer: { taskId },
    });
    for (const sk of (artifacts && artifacts.skipped) || []) console.error('[taskRun] artifact not ingested', sk.path, sk.reason);
  } catch (e) {
    console.error('[taskRun] artifact ingest failed', taskId, (e && e.message) || e);
  }
  // The folder is per-Task and single-use: drop it once ingest emptied it. Never recursive —
  // anything left behind (skipped / failed ingest) stays for the daily staging sweep.
  try {
    nodeFs.rmdirSync(artifactsDir);
  } catch (e) {
    const code = e && e.code;
    if (code === 'ENOTEMPTY' || code === 'EEXIST') console.error('[taskRun] artifact staging folder kept (not empty)', artifactsDir);
    else if (code !== 'ENOENT') console.error('[taskRun] artifact staging folder not removed', artifactsDir, (e && e.message) || e);
  }
  return { ...result, artifacts };
}

/** runTask without the artifacts step. Resolves — never throws. */
async function spawnTask({ args, env, prompt, cwd, timeoutMs = 600_000, signal, onSpawn, onStdoutLine, deps = {} } = /** @type {any} */ ({})) {
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
    stdoutCapped: false,
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
    let stdoutCapped = false;

    // Line splitter over EVERY stdout byte (not just the captured ones).
    // O(bytes) total: each chunk is decoded once and scanned once for '\n';
    // only one partial line is held, never more than MAX_STDOUT_BYTES of it.
    const decoder = new StringDecoder('utf8');
    let partial = '';
    let partialBytes = 0;
    let droppingLine = false; // the current line already overflowed and was delivered truncated
    /** @type {any} */
    let lastResult = null;
    let sawRejectedRateLimit = false;
    /** @type {string|null} */
    let lastRejectedResetsAt = null;
    const deliver = (line) => {
      if (typeof onStdoutLine === 'function') {
        try { onStdoutLine(line); } catch { /* caller hook must not break the run */ }
      }
      if (line[0] !== '{' || !(line.includes('"result"') || line.includes('rate_limit_event'))) return;
      let ev;
      try { ev = JSON.parse(line); } catch { return; }
      if (!ev || typeof ev !== 'object') return;
      if (ev.type === 'result') lastResult = ev;
      else if (ev.type === 'rate_limit_event' && ev.rate_limit_info && ev.rate_limit_info.status === 'rejected') {
        sawRejectedRateLimit = true;
        const r = resetsAtOf(ev);
        if (r) lastRejectedResetsAt = r;
      }
    };
    const feedLines = (str) => {
      let start = 0;
      for (;;) {
        const nl = str.indexOf('\n', start);
        const piece = nl === -1 ? str.slice(start) : str.slice(start, nl);
        if (!droppingLine && piece) {
          partial += piece;
          partialBytes += Buffer.byteLength(piece, 'utf8');
          if (partialBytes > MAX_STDOUT_BYTES) {
            deliver(Buffer.from(partial, 'utf8').subarray(0, MAX_STDOUT_BYTES).toString('utf8'));
            partial = '';
            partialBytes = 0;
            droppingLine = true;
          }
        }
        if (nl === -1) return;
        if (!droppingLine) deliver(partial.endsWith('\r') ? partial.slice(0, -1) : partial);
        partial = '';
        partialBytes = 0;
        droppingLine = false;
        start = nl + 1;
      }
    };
    const flushLines = () => {
      feedLines(decoder.end());
      if (!droppingLine && partial) deliver(partial.endsWith('\r') ? partial.slice(0, -1) : partial);
      partial = '';
      partialBytes = 0;
    };

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
      assertNoCredentials(env, { site: 'task' });
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
      const buf = Buffer.isBuffer(d) ? d : Buffer.from(String(d));
      try { feedLines(decoder.write(buf)); } catch { /* line tracking must not break capture */ }
      if (stdoutBytes >= MAX_STDOUT_BYTES) { if (buf.length) stdoutCapped = true; return; }
      const room = MAX_STDOUT_BYTES - stdoutBytes;
      if (buf.length > room) stdoutCapped = true;
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
      try { flushLines(); } catch { /* line tracking must not break the result */ }
      // Under the cap the captured stdout is authoritative (unchanged behavior);
      // once capped, the line-tracked state is what survived past the cut.
      const envelope = stdoutCapped ? (lastResult || parseEnvelope(stdout)) : (parseEnvelope(stdout) || lastResult);
      const rateLimited = detectRateLimitInText(stdout)
        || (envelope ? detectRateLimitInText(JSON.stringify(envelope)) : false)
        || (stdoutCapped && sawRejectedRateLimit);
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
        quota: { rateLimited, resetsAt: rateLimited ? (parseResetsAt(stdout) || lastRejectedResetsAt) : null },
        stdoutCapped,
      });
    });
  });
}

module.exports = { buildTaskArgs, buildTaskEnv, withToolRiskGuard, runTask, textStdoutFor, parseEnvelope, MAX_STDOUT_BYTES, STDERR_TAIL_BYTES, MAX_ARG_BYTES };

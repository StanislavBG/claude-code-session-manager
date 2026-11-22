/**
 * taskAdminRoutes.cjs — the admin HTTP face of the Task primitive.
 *
 *   POST /admin/tasks
 *     Run ONE headless `claude -p` for a project, under the machine-wide slot
 *     cap, recorded in that project's Task ledger. Order:
 *       1. strict body schema (400 invalid_request), sessionId+resume /
 *          resume+persistSession:false / missing mcpConfig file (400);
 *       2. the human switch 'Scripts may run Tasks' (403 tasks_disabled);
 *       3. persona → model + effort with the SPAWN-time resolvers
 *          (agentModelResolve.cjs / agentEffortResolve.cjs — never
 *          FALLBACK_MODEL, never effectiveModelInfo.cjs): 404 unknown_agent,
 *          422 model_unresolved, 422 effort_unresolved. The persona BODY is
 *          never read into the prompt or argv;
 *       4. 409 session_busy when another running Task holds the session;
 *       5. ledger start line, THEN sessionSlots.waitForSlot by priority lane
 *          (null → 'slot_timeout', too_many_waiting → 429);
 *       6. taskRun.runTask, token released in finally, ledger end line with
 *          costUsd from modelPricing.costOfUsage;
 *       7. 200 { ok: true, taskId, status, stdout, envelope, usage, costUsd,
 *          cliCostUsd, durationMs, slotWaitMs, exitCode, model, effort,
 *          sessionId, quota }.
 *   A req/res 'close' before the reply aborts the wait or the run
 *   ('caller_gone'); the route disables the socket timeout (runs are long).
 *
 * No caller environment variable ever reaches the child (buildTaskEnv adds
 * only the Task markers to process.env). Auth/loopback binding are the
 * injected localAdminHttp.cjs transport's job (see index.cjs).
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { z } = require('zod');
const { readBody, sendJson } = require('../feedback-remote/localAdminHttp.cjs');
const { resolveProjectRoot } = require('../opsOwnership.cjs');

const MAX_BODY_BYTES = 4 * 1024 * 1024;
const MAX_SYSTEM_PROMPT_BYTES = 100 * 1024;
const SWITCH_HINT = "Turn on 'Scripts may run Tasks' for this project on the Scheduler → Tasks page (a human-only switch).";

function isAbsoluteDir(p) {
  if (typeof p !== 'string' || !path.isAbsolute(p)) return false;
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

const runtimeSchema = z.object({
  outputFormat: z.enum(['json', 'text', 'stream-json']).default('json'),
  settingSources: z.string().optional(),
  mcpConfig: z.array(z.string().min(1)).optional(),
  strictMcpConfig: z.boolean().optional(),
  // An empty array is valid: it means "deny all".
  allowedTools: z.array(z.string()).optional(),
  tools: z.array(z.string()).optional(),
  maxTurns: z.number().int().min(1).max(200).optional(),
  systemPrompt: z.string()
    .refine((s) => Buffer.byteLength(s, 'utf8') <= MAX_SYSTEM_PROMPT_BYTES, { message: `systemPrompt exceeds ${MAX_SYSTEM_PROMPT_BYTES} bytes` })
    .optional(),
  skipPermissions: z.boolean().optional(),
  disableAutoMemory: z.boolean().optional(),
  sessionId: z.string().uuid().optional(),
  resume: z.string().uuid().optional(),
  persistSession: z.boolean().optional(),
  cwd: z.string().refine(isAbsoluteDir, { message: 'runtime.cwd must be an absolute existing directory' }).optional(),
}).strict();

const bodySchema = z.object({
  cwd: z.string().min(1),
  agent: z.string().min(1).max(200),
  missionId: z.string().min(1).max(200),
  prompt: z.string().min(1),
  timeoutSec: z.number().int().min(1).max(3600).default(600),
  slotWaitSec: z.number().int().min(0).max(3600).default(120),
  priority: z.enum(['interactive', 'batch']).default('batch'),
  caller: z.object({
    pipeline: z.string().max(200).optional(),
    runId: z.string().max(200).optional(),
    step: z.string().max(200).optional(),
    attempt: z.number().int().min(0).optional(),
  }).strict().default({}),
  runtime: runtimeSchema.default({ outputFormat: 'json' }),
}).strict();

/**
 * Default persona resolution — the spawn-time resolvers chatRunner.cjs uses.
 * `personaFound` comes from agentLibrary.getPersonaBody (whose body is
 * discarded here); model = persona `model` (overlay-aware) else the Settings
 * model — never agentModelResolve's FALLBACK_MODEL.
 * @param {{ cwd: string, agent: string }} a
 * @returns {Promise<{ personaFound: boolean, resolvedModelId: string|null, personaEffort: string|null }>}
 */
async function defaultResolveInfo({ cwd, agent }) {
  const { getPersonaBody } = require('../../agentLibrary.cjs');
  const persona = await getPersonaBody({ cwd, name: agent });
  if (!persona) return { personaFound: false, resolvedModelId: null, personaEffort: null };
  const { readOverlayAwarePersonaModel } = require('../claude/agentModelResolve.cjs');
  const { resolveEpicEffort } = require('../claude/agentEffortResolve.cjs');
  const { readSettingsModel } = require('../claude/modelCatalog.cjs');
  let model = readOverlayAwarePersonaModel(agent, { cwd });
  if (!model || model === 'inherit') model = readSettingsModel(cwd);
  const { effort } = resolveEpicEffort({ cwd, agentType: agent });
  return { personaFound: true, resolvedModelId: model || null, personaEffort: effort || null };
}

/** A real `--model` value: a non-empty string that is not the 'inherit' sentinel. */
function isConcreteModel(m) {
  return typeof m === 'string' && m.trim() !== '' && m.trim() !== 'inherit';
}

/** Price the run: the first concrete model the CLI reported, else the model we passed. */
function costFor(model, run, costOfUsage) {
  const u = run && run.usage;
  if (!u || typeof u !== 'object') return null;
  const reported = run.modelUsage && typeof run.modelUsage === 'object' ? Object.keys(run.modelUsage)[0] : null;
  const cc = u.cache_creation && typeof u.cache_creation === 'object' ? u.cache_creation : null;
  const bucket = {
    inputTokens: u.input_tokens,
    outputTokens: u.output_tokens,
    cacheReadTokens: u.cache_read_input_tokens,
    cacheCreationTokens: u.cache_creation_input_tokens,
    ...(cc && typeof cc.ephemeral_1h_input_tokens === 'number' ? { cacheCreation1hTokens: cc.ephemeral_1h_input_tokens } : {}),
  };
  try {
    const r = costOfUsage(reported || model, bucket);
    return r && typeof r.costUsd === 'number' ? r.costUsd : null;
  } catch {
    return null;
  }
}

/**
 * @param {{ registerRoute: Function }} adminHttp
 * @param {{ taskSwitch?: any, resolveInfo?: Function, sessionSlots?: any, runTask?: Function,
 *   buildTaskArgs?: Function, buildTaskEnv?: Function, ledger?: any, costOfUsage?: Function,
 *   now?: () => number, randomUUID?: () => string, resolveProjectRoot?: Function }} [deps]
 */
function registerAdminRoute(adminHttp, deps = {}) {
  // Lazy defaults: agentLibrary / slots / spawn pull in heavy modules.
  const taskSwitch = () => deps.taskSwitch || require('./taskSwitch.cjs');
  const resolveInfo = deps.resolveInfo || defaultResolveInfo;
  const slots = () => deps.sessionSlots || require('../scheduler/sessionSlots.cjs');
  const taskRun = () => require('./taskRun.cjs');
  const runTask = (/** @type {any} */ o) => (deps.runTask || taskRun().runTask)(o);
  const buildArgs = (/** @type {any} */ o) => (deps.buildTaskArgs || taskRun().buildTaskArgs)(o);
  const buildEnv = (/** @type {any} */ rt, /** @type {any} */ env) => (deps.buildTaskEnv || taskRun().buildTaskEnv)(rt, env);
  const ledger = () => deps.ledger || require('./taskLedger.cjs');
  const costOfUsage = (/** @type {any} */ m, /** @type {any} */ b) => (deps.costOfUsage || require('../claude/modelPricing.cjs').costOfUsage)(m, b);
  const now = deps.now || Date.now;
  const newId = deps.randomUUID || (() => crypto.randomUUID());
  const projectRoot = deps.resolveProjectRoot || resolveProjectRoot;

  /** sessionId → taskId for every Task currently between its start line and its end line. */
  const busySessions = new Map();

  adminHttp.registerRoute('POST', '/admin/tasks', async (/** @type {any} */ req, /** @type {any} */ res) => {
    try { if (typeof res.setTimeout === 'function') res.setTimeout(0); } catch { /* */ }
    try { if (typeof req.setTimeout === 'function') req.setTimeout(0); } catch { /* */ }

    let replied = false;
    const reply = (/** @type {number} */ status, /** @type {any} */ obj) => {
      if (replied) return;
      replied = true;
      if (res.writableEnded || res.destroyed) return;
      sendJson(res, status, obj);
    };

    let raw;
    try {
      raw = await readBody(req, MAX_BODY_BYTES);
    } catch (e) {
      reply(400, { ok: false, error: 'invalid_request', details: e instanceof Error ? e.message : String(e) });
      return;
    }
    let parsedJson;
    try {
      parsedJson = JSON.parse(raw || '{}');
    } catch (e) {
      reply(400, { ok: false, error: 'invalid_request', details: 'body is not valid JSON' });
      return;
    }
    const parsed = bodySchema.safeParse(parsedJson);
    if (!parsed.success) {
      reply(400, { ok: false, error: 'invalid_request', details: parsed.error.issues });
      return;
    }
    const input = parsed.data;
    /** @type {Record<string, any>} */
    const runtime = { ...input.runtime };

    let cwd;
    try {
      cwd = projectRoot(input.cwd);
    } catch (e) {
      reply(400, { ok: false, error: 'invalid_request', details: e instanceof Error ? e.message : String(e) });
      return;
    }
    if (runtime.sessionId && runtime.resume) {
      reply(400, { ok: false, error: 'invalid_request', details: 'runtime.sessionId and runtime.resume are mutually exclusive' });
      return;
    }
    if (runtime.resume && runtime.persistSession === false) {
      reply(400, { ok: false, error: 'invalid_request', details: 'runtime.resume always persists the session; persistSession:false contradicts it' });
      return;
    }
    if (Array.isArray(runtime.mcpConfig)) {
      const missing = runtime.mcpConfig.map((p) => path.resolve(cwd, p)).filter((p) => !fs.existsSync(p));
      if (missing.length) {
        reply(400, { ok: false, error: 'mcp_config_missing', details: missing });
        return;
      }
    }

    if (!taskSwitch().isTaskSwitchOn(cwd)) {
      reply(403, { ok: false, error: 'tasks_disabled', hint: SWITCH_HINT });
      return;
    }

    const info = await resolveInfo({ cwd, agent: input.agent });
    if (!info || !info.personaFound) {
      reply(404, { ok: false, error: 'unknown_agent', agent: input.agent });
      return;
    }
    const model = info.resolvedModelId;
    if (!isConcreteModel(model)) {
      reply(422, { ok: false, error: 'model_unresolved', agent: input.agent });
      return;
    }
    const effort = info.personaEffort;
    if (typeof effort !== 'string' || !effort.trim()) {
      reply(422, { ok: false, error: 'effort_unresolved', agent: input.agent });
      return;
    }

    const taskId = newId();
    if (runtime.persistSession === true && !runtime.sessionId && !runtime.resume) runtime.sessionId = taskId;
    const sessionId = runtime.sessionId || runtime.resume || null;
    const persisted = runtime.persistSession === true || Boolean(runtime.resume);

    if (sessionId && busySessions.has(sessionId)) {
      reply(409, { ok: false, error: 'session_busy', sessionId, heldBy: busySessions.get(sessionId) });
      return;
    }

    // buildTaskArgs' flag name for the permission bypass.
    const argsRuntime = { ...runtime };
    delete argsRuntime.skipPermissions;
    delete argsRuntime.cwd;
    if (runtime.skipPermissions === true) argsRuntime.dangerouslySkipPermissions = true;

    let args;
    try {
      args = buildArgs({ model, effort, runtime: argsRuntime, projectCwd: cwd });
    } catch (e) {
      reply(400, { ok: false, error: (e && /** @type {any} */ (e).code) || 'invalid_request', details: e instanceof Error ? e.message : String(e) });
      return;
    }
    const env = buildEnv(runtime, process.env);

    const ac = new AbortController();
    const onClose = () => { if (!replied) ac.abort(); };
    req.on('close', onClose);
    res.on('close', onClose);

    const startedMs = now();
    const startedAt = new Date(startedMs).toISOString();
    if (sessionId) busySessions.set(sessionId, taskId);
    try {
      await ledger().appendTaskStart(cwd, {
        taskId,
        startedAt,
        agent: input.agent,
        missionId: input.missionId,
        model,
        effort,
        priority: input.priority,
        timeoutSec: input.timeoutSec,
        slotWaitSec: input.slotWaitSec,
        caller: input.caller,
        outputFormat: runtime.outputFormat,
        sessionId,
        persisted,
        prompt: input.prompt,
      });

      const end = (/** @type {Record<string, any>} */ row) => ledger().appendTaskEnd(cwd, {
        taskId,
        startedAt,
        endedAt: new Date(now()).toISOString(),
        model,
        sessionId,
        persisted,
        ...row,
      });

      const lane = input.priority === 'interactive' ? 'task-interactive' : 'task-batch';
      const waitStart = now();
      let token;
      try {
        token = await slots().waitForSlot(`task:${taskId}`, { lane, timeoutMs: input.slotWaitSec * 1000, signal: ac.signal });
      } catch (e) {
        const code = (e && /** @type {any} */ (e).code) || 'slot_error';
        await end({ status: code, slotWaitMs: now() - waitStart });
        reply(code === 'too_many_waiting' ? 429 : 500, { ok: false, error: code, taskId });
        return;
      }
      const slotWaitMs = now() - waitStart;
      if (token == null) {
        const status = ac.signal.aborted ? 'caller_gone' : 'slot_timeout';
        await end({ status, slotWaitMs });
        reply(503, { ok: false, error: status, taskId, slotWaitMs });
        return;
      }

      let run;
      try {
        run = await runTask({
          args,
          env,
          prompt: input.prompt,
          cwd: runtime.cwd || cwd,
          timeoutMs: input.timeoutSec * 1000,
          signal: ac.signal,
          onSpawn: (/** @type {number} */ pid) => { try { slots().stampPid(token, pid); } catch { /* */ } },
        });
      } finally {
        try { slots().release(token); } catch { /* */ }
      }

      const costUsd = costFor(model, run, costOfUsage);
      const finalSessionId = sessionId || run.sessionId || null;
      await end({
        status: run.status,
        exitCode: run.exitCode,
        signal: run.signal,
        durationMs: run.durationMs,
        slotWaitMs,
        usage: run.usage,
        costUsd,
        cliCostUsd: run.cliCostUsd,
        numTurns: run.numTurns,
        quota: run.quota,
        sessionId: finalSessionId,
        output: run.stdout,
        stderrTail: run.stderrTail,
        envelope: run.envelope,
      });

      const { textStdoutFor } = taskRun();
      reply(200, {
        ok: true,
        taskId,
        status: run.status,
        stdout: runtime.outputFormat === 'text' ? textStdoutFor(run.envelope) : run.stdout,
        envelope: run.envelope,
        usage: run.usage,
        costUsd,
        cliCostUsd: run.cliCostUsd,
        durationMs: run.durationMs,
        slotWaitMs,
        exitCode: run.exitCode,
        model,
        effort,
        sessionId: finalSessionId,
        quota: run.quota,
      });
    } finally {
      if (sessionId && busySessions.get(sessionId) === taskId) busySessions.delete(sessionId);
      req.removeListener('close', onClose);
      res.removeListener('close', onClose);
    }
  });
}

module.exports = { registerAdminRoute, MAX_BODY_BYTES };

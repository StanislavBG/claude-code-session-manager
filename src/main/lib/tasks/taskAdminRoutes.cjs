/**
 * taskAdminRoutes.cjs — the admin HTTP face of the Task primitive.
 *
 *   POST /admin/tasks
 *     Run ONE headless `claude -p` for a project, under the machine-wide slot
 *     cap, recorded in that project's Task ledger. Order:
 *       1. strict body schema (400 invalid_request), sessionId+resume /
 *          resume+persistSession:false / missing mcpConfig file (400);
 *       2. the held interactive slot is re-synced from the switch file
 *          (taskSwitch.syncInteractiveReserve; a throw is ignored), then the
 *          human switch 'Scripts may run Tasks' (403 tasks_disabled);
 *       3. persona → model + effort with the SPAWN-time resolvers
 *          (agentModelResolve.cjs / agentEffortResolve.cjs — never
 *          FALLBACK_MODEL, never effectiveModelInfo.cjs): 404 unknown_agent,
 *          422 model_unresolved, 422 effort_unresolved. The persona BODY is
 *          never read into the prompt or argv;
 *       4. 409 session_busy when another running Task holds the session;
 *          then buildTaskArgs (400);
 *       5. the usage hold (scheduler.currentUsageHold — the same 'pause
 *          above' rule the PRD queue holds at): a hold → 429 usage_held
 *          { hold: { reason, window, percent, threshold, resetsAt }, detail,
 *          hint }, a throw → 503 usage_hold_error, both before any ledger
 *          line. No body key, priority or caller bypasses it — this loopback
 *          route cannot prove a human. One 'task_usage_held' audit event per
 *          project root per hold (holdIdentityKey), not per request;
 *       6. ledger start line, THEN sessionSlots.waitForSlot by priority lane
 *          (null → 'slot_timeout', too_many_waiting → 429);
 *       7. once the slot is granted the usage hold is read AGAIN: a hold or
 *          a throw releases the token and writes the end line status
 *          'usage_held' + slotWaitMs; a hold replies 429 usage_held, a throw
 *          503 usage_hold_error (both + taskId, slotWaitMs) — a Task that
 *          waited through the hold never spawns;
 *       8. taskRun.runTask, token released in finally, ledger end line with
 *          costUsd from modelPricing.costOfUsage;
 *       9. 200 { ok: true, taskId, status, stdout, envelope, usage, costUsd,
 *          cliCostUsd, durationMs, slotWaitMs, exitCode, model, effort,
 *          sessionId, quota }.
 *   A req/res 'close' before the reply aborts the wait or the run
 *   ('caller_gone'); the route disables the socket timeout (runs are long).
 *
 *   Stream mode (body stream: true): every refusal before the ledger start
 *   line keeps its status + JSON body. After the start line the route answers
 *   200 application/x-ndjson, one JSON object per line:
 *     {type:'sm_task_started', taskId, model, effort, sessionId, startedAt}
 *       — written before the slot wait;
 *     {type:'sm_task_running', slotWaitMs} — once the slot is granted;
 *     each child stdout line as it arrives: as-is when it parses as a JSON
 *       object, else {type:'sm_task_stdout', text};
 *     {type:'sm_task_result', ...} — last: the non-stream 200 reply plus
 *       droppedLines, or the error object the JSON reply would carry
 *       (e.g. ok:false, error:'slot_timeout', taskId, slotWaitMs).
 *   A 'close' before the result line still aborts the wait or the run
 *   (caller_gone). While res.writableLength exceeds 8 MiB, output lines are
 *   skipped and counted in droppedLines, so a caller that stops reading
 *   cannot grow memory. The stream never carries stderr, env or argv.
 *
 *   GET /admin/tasks?cwd=&since=&until=&pipeline=&runId=&step=&agent=&status=&source=&limit=&offset=
 *     → { ok, tasks, total, hasMore } from taskLedger.listTasks. Each task has
 *     exactly TASK_FIELDS (no prompt/output text). Works whatever the switch.
 *   GET /admin/task?cwd=&id=&after=
 *     → { ok, task } — TASK_FIELDS plus prompt, output, stderrTail, envelope
 *     (and the truncation flags) from the body file, plus live; 404 unknown_task.
 *     A Task this process is still running (the in-process live registry,
 *     filled from every POST run's stdout lines) answers status 'running',
 *     output = the captured lines from byte offset `after` (default 0), up to
 *     1 MiB cut at a line boundary, outputTruncated when more remain, and
 *     live = { slotAcquired, outputEnd, outputCapped } (pass outputEnd as the
 *     next `after`). Any other Task: live null; `after` slices the stored
 *     output by bytes, rounded forward to a line boundary. GET /admin/tasks
 *     also reports a live Task as 'running', never 'interrupted'.
 *   POST /admin/tasks/import  (body ≤ 8 MiB)
 *     { cwd, records: 1-100 } — direct `claude -p` calls a caller made while
 *     Session Manager was down. Re-syncs the held interactive slot from the
 *     switch file, then 403 tasks_disabled when the switch is off.
 *     Each record is validated on its own and recorded with
 *     taskLedger.appendImported (source 'direct'); a known (cwd, importId) is
 *     skipped. costUsd is recomputed with costOfUsage when usage is present
 *     (the caller's figure is kept as cliCostUsd).
 *     → { ok, imported, alreadyImported, rejected: [{ index, error }] }.
 *   Read and import routes take a cwd that must be a project root (400).
 *   POST /admin/tasks/switch  (taskSwitchRoute.cjs, registered from here)
 *     The agent path for the switch: sets one project's switch only on a
 *     verified verbatim quote of the human's own chat prompt naming it.
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
const { phaseOfTask } = require('../phaseProjection.cjs');
const { registerTaskSwitchRoute } = require('./taskSwitchRoute.cjs');
const { usageHeldBody } = require('../scheduler/usageHoldRoute.cjs');

const MAX_BODY_BYTES = 4 * 1024 * 1024;
const MAX_IMPORT_BODY_BYTES = 8 * 1024 * 1024;
const MAX_IMPORT_RECORDS = 100;
const MAX_SYSTEM_PROMPT_BYTES = 100 * 1024;
const SWITCH_HINT = "Turn on 'Scripts may run Tasks' for this project: a human flips it on the Scheduler → Tasks page, or an agent in a Session Manager chat calls task_switch_set with the human's own words asking for it.";

function isAbsoluteDir(p) {
  if (typeof p !== 'string' || !path.isAbsolute(p)) return false;
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

const MAX_TOOL_RULES = 50;
const MAX_TOOL_RULE_CHARS = 500;

/**
 * A permission rule the CLI's --disallowedTools list parser reads as ONE rule:
 * trimmed-non-empty, <= 500 chars, no control characters, and when it has '('
 * a tool name before it, a trailing ')' and balanced parentheses. An unbalanced
 * '(' would make the CLI swallow later text into one broken rule — a deny that
 * silently never applies — so it is refused, never passed on. The first
 * character must be an ASCII letter (tool names and mcp__ rules all are), so a
 * '-'-leading or space-leading value can never be read as a CLI flag.
 * @param {unknown} s
 */
function isValidToolRule(s) {
  if (typeof s !== 'string') return false;
  if (!/^[A-Za-z]/.test(s)) return false;
  if (s.trim() === '' || s.length > MAX_TOOL_RULE_CHARS) return false;
  if (/[\u0000-\u001f\u007f]/.test(s)) return false;
  if (!s.includes('(') && !s.includes(')')) return true;
  const open = s.indexOf('(');
  if (open <= 0 || s.slice(0, open).trim() === '' || !s.endsWith(')')) return false;
  let depth = 0;
  for (const ch of s) {
    if (ch === '(') depth += 1;
    else if (ch === ')') { depth -= 1; if (depth < 0) return false; }
  }
  return depth === 0;
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
  appendSystemPrompt: z.string()
    .refine((s) => Buffer.byteLength(s, 'utf8') <= MAX_SYSTEM_PROMPT_BYTES, { message: `appendSystemPrompt exceeds ${MAX_SYSTEM_PROMPT_BYTES} bytes` })
    .optional(),
  // Permission deny rules ('WebFetch(domain:localhost)'); each reaches the CLI as one
  // '--disallowedTools=<rule>' element — after a bare variadic flag a '-'-leading value
  // is parsed as a new flag, so the '=' form plus the leading-letter check stop injection.
  disallowedTools: z.array(z.string().refine(isValidToolRule, { message: 'invalid tool rule' })).max(MAX_TOOL_RULES).optional(),
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
  // true → 200 application/x-ndjson after the ledger start line (see the header).
  stream: z.boolean().optional(),
}).strict();

/** Past this many unsent bytes in the response buffer, stream-mode output lines are dropped (and counted). */
const MAX_STREAM_BUFFER_BYTES = 8 * 1024 * 1024;

/** Outcome statuses an imported record may carry: the ledger's end statuses (taskRun + route). */
const IMPORT_STATUSES = /** @type {const} */ ([
  'ok', 'error', 'rate_limited', 'timeout', 'spawn_failed', 'caller_gone', 'slot_timeout', 'too_many_waiting', 'interrupted',
]);

/** The keys of one Task in GET /admin/tasks (and the summary part of GET /admin/task). */
const TASK_FIELDS = Object.freeze([
  'taskId', 'source', 'importId', 'importedAt', 'agent', 'missionId', 'model', 'effort', 'priority', 'caller',
  'outputFormat', 'timeoutSec', 'slotWaitSec', 'sessionId', 'persisted', 'startedAt', 'endedAt', 'status',
  'exitCode', 'signal', 'durationMs', 'slotWaitMs', 'usage', 'costUsd', 'cliCostUsd', 'numTurns', 'quota',
  'promptBytes', 'promptSha256', 'outputBytes', 'outputSha256', 'phase',
]);

/** @param {Record<string, any>} t a folded ledger Task → exactly TASK_FIELDS (missing → null). */
function publicTask(t) {
  /** @type {Record<string, any>} */
  const out = {};
  for (const k of TASK_FIELDS) out[k] = t[k] === undefined ? null : t[k];
  if (!out.source) out.source = 'sm';
  if (out.caller == null) out.caller = {};
  out.persisted = t.persisted === true;
  out.phase = phaseOfTask(t); // phaseProjection.cjs — never stored, derived from status
  return out;
}

const isoDate = z.string().refine((s) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s) && Number.isFinite(Date.parse(s)), { message: 'must be an ISO date' });

const listQuerySchema = z.object({
  cwd: z.string().min(1),
  since: isoDate.optional(),
  until: isoDate.optional(),
  pipeline: z.string().max(200).optional(),
  runId: z.string().max(200).optional(),
  step: z.string().max(200).optional(),
  agent: z.string().max(200).optional(),
  status: z.string().max(100).optional(),
  source: z.enum(['sm', 'direct']).optional(),
  limit: z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().min(1).max(200)).optional(),
  offset: z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().min(0)).optional(),
}).strict();

const getQuerySchema = z.object({
  cwd: z.string().min(1),
  id: z.string().min(1).max(200),
  // Byte offset into the Task's stdout to read from (a live Task's live.outputEnd).
  after: z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().min(0)).optional(),
}).strict();

/** Keys POST /admin/tasks accepts at the top level and under runtime, and GET /admin/task query keys (advertised on the health route via externalContract.cjs). */
const TASK_BODY_KEYS = Object.freeze(Object.keys(bodySchema.shape));
const TASK_RUNTIME_KEYS = Object.freeze(Object.keys(runtimeSchema.shape));
const TASK_GET_KEYS = Object.freeze(Object.keys(getQuerySchema.shape));

/** One GET /admin/task page of a live Task's captured output. */
const LIVE_PAGE_BYTES = 1024 * 1024;

/**
 * A live Task's captured stdout: lines plus cumulative end byte offsets
 * (ends[i] = bytes of lines[0..i] each counted with its '\n').
 * @typedef {{ cwd: string, lines: string[], ends: number[], bytes: number,
 *   slotAcquired: boolean, outputCapped: boolean }} LiveTask
 */

/** @param {number} cap @param {string} cwd @returns {LiveTask & { append: (line: string) => void }} */
function newLiveTask(cwd, cap) {
  /** @type {any} */
  const lt = { cwd, lines: [], ends: [], bytes: 0, slotAcquired: false, outputCapped: false };
  lt.append = (/** @type {string} */ line) => {
    if (lt.outputCapped) return;
    const b = Buffer.byteLength(line + '\n', 'utf8');
    if (lt.bytes + b > cap) { lt.outputCapped = true; return; }
    lt.lines.push(line);
    lt.bytes += b;
    lt.ends.push(lt.bytes);
    if (lt.bytes >= cap) lt.outputCapped = true;
  };
  return lt;
}

/**
 * The page of a live Task's lines starting at byte offset `after`.
 * Binary search for the first line whose START offset (ends[i-1], or 0) is
 * >= after: O(log n) over n captured lines, then O(k) over the k lines taken
 * (at most LIVE_PAGE_BYTES of them).
 * @param {LiveTask} lt @param {number} after
 * @returns {{ output: string, outputTruncated: boolean, outputEnd: number }}
 */
function livePage(lt, after) {
  const { lines, ends } = lt;
  let lo = 0;
  let hi = lines.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const start = mid === 0 ? 0 : ends[mid - 1];
    if (start >= after) hi = mid; else lo = mid + 1;
  }
  const first = lo;
  const pageStart = first === 0 ? 0 : ends[first - 1];
  let i = first;
  while (i < lines.length && ends[i] - pageStart <= LIVE_PAGE_BYTES) i += 1;
  // A single line longer than a page is still delivered alone, so a reader always advances.
  if (i === first && i < lines.length) i += 1;
  const taken = lines.slice(first, i);
  return {
    output: taken.length ? taken.join('\n') + '\n' : '',
    outputTruncated: i < lines.length,
    outputEnd: i > first ? ends[i - 1] : after,
  };
}

/**
 * A finished Task's stored output from byte offset `after`, rounded forward to
 * the next line boundary; an offset at or past the end gives ''. O(output bytes).
 * @param {string} text @param {number} after
 */
function sliceFromByte(text, after) {
  if (!after) return text;
  const buf = Buffer.from(text, 'utf8');
  if (after >= buf.length) return '';
  let start = after;
  if (buf[start - 1] !== 0x0a) {
    const nl = buf.indexOf(0x0a, start);
    if (nl === -1) return '';
    start = nl + 1;
  }
  return buf.subarray(start).toString('utf8');
}

const { CallerSchema: callerSchema } = require('../epic/scriptStartedBy.cjs');

const usageNumber = z.number().int().min(0).optional();
const importRecordSchema = z.object({
  importId: z.string().min(1).max(200),
  agent: z.string().min(1).max(200).optional(),
  model: z.string().min(1).max(200),
  effort: z.string().min(1).max(50).optional(),
  missionId: z.string().min(1).max(200),
  caller: callerSchema.optional(),
  startedAt: isoDate,
  durationMs: z.number().int().min(0),
  status: z.enum(IMPORT_STATUSES),
  exitCode: z.number().int().nullable().optional(),
  usage: z.object({
    input_tokens: usageNumber,
    output_tokens: usageNumber,
    cache_read_input_tokens: usageNumber,
    cache_creation_input_tokens: usageNumber,
  }).passthrough().optional(),
  costUsd: z.number().min(0).nullable().optional(),
  sessionId: z.string().uuid().optional(),
  persisted: z.boolean().optional(),
  prompt: z.string().optional(),
  output: z.string().optional(),
  envelope: z.unknown().optional(),
}).strict().refine((r) => r.persisted !== true || Boolean(r.sessionId), { message: 'persisted: true needs a sessionId' });

const importBodySchema = z.object({
  cwd: z.string().min(1),
  records: z.array(z.unknown()).min(1).max(MAX_IMPORT_RECORDS),
}).strict();

/** First zod issue as one line: "<path>: <message>". */
function issueText(/** @type {any} */ error) {
  const i = error && error.issues && error.issues[0];
  if (!i) return 'invalid record';
  return `${i.path && i.path.length ? `${i.path.join('.')}: ` : ''}${i.message}`;
}

/**
 * Default persona resolution — the spawn-time resolvers chatRunner.cjs uses.
 * `personaFound` comes from agentLibrary.getPersonaBody (whose body is
 * discarded here); model = persona `model` (overlay-aware) else the Settings
 * model — never agentModelResolve's FALLBACK_MODEL.
 * @param {{ cwd: string, agent: string }} a
 * declaredMcpServers = the persona's `mcpServers:` (overlay-aware), the only
 * MCP servers the strict Task spawn loads.
 * @returns {Promise<{ personaFound: boolean, resolvedModelId: string|null, personaEffort: string|null, declaredMcpServers: string[] }>}
 */
async function defaultResolveInfo({ cwd, agent }) {
  const { getPersonaBody, parseCapabilityList } = require('../../agentLibrary.cjs');
  const persona = await getPersonaBody({ cwd, name: agent });
  if (!persona) return { personaFound: false, resolvedModelId: null, personaEffort: null, declaredMcpServers: [] };
  const { readOverlayAwarePersonaModel } = require('../claude/agentModelResolve.cjs');
  const { resolveEpicEffort } = require('../claude/agentEffortResolve.cjs');
  const { readSettingsModel } = require('../claude/modelCatalog.cjs');
  let model = readOverlayAwarePersonaModel(agent, { cwd });
  if (!model || model === 'inherit') model = readSettingsModel(cwd);
  const { effort } = resolveEpicEffort({ cwd, agentType: agent });
  let declaredMcpServers = [];
  try {
    const { readOverlayAwarePersona } = require('../claude/agentModelResolve.cjs');
    const p = readOverlayAwarePersona(agent, { cwd });
    declaredMcpServers = parseCapabilityList(p && p.fm ? p.fm.mcpServers : undefined);
  } catch { /* unreadable frontmatter → no declared servers (strict mode loads none) */ }
  let skillDeny = [];
  try {
    const { readOverlayAwarePersona } = require('../claude/agentModelResolve.cjs');
    const { loadoutState } = require('../persona-macro/personaLoadout.cjs');
    const { resolveSkillDeny } = require('../claude/personaToolScope.cjs');
    const p = readOverlayAwarePersona(agent, { cwd });
    const fm = p && p.fm ? p.fm : null;
    skillDeny = (await resolveSkillDeny({ packs: parseCapabilityList(fm ? fm.packs : undefined), loadout: fm ? loadoutState(fm) : null })).args;
  } catch { /* no skill deny on failure */ }
  return { personaFound: true, resolvedModelId: model || null, personaEffort: effort || null, declaredMcpServers, skillDeny };
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
 * The live registry (taskId → LiveTask) of the most recently registered
 * POST /admin/tasks route. Production registers the route once; in tests the
 * last registerAdminRoute call wins. null until a route is registered.
 * @type {Map<string, { cwd: string }> | null}
 */
let activeLiveTasks = null;

/**
 * taskIds the most recently registered POST /admin/tasks route is running for
 * project root `root` (path.resolve equality) — [] when none, or when no route
 * is registered. The GET routes and the desktop Tasks IPC (taskIpc.cjs) pass
 * these as liveTaskIds so every Task read folds a live run as running.
 * Production registers the route once; in tests the last registration wins.
 * @param {string} root
 * @returns {string[]}
 */
function liveTaskIdsFor(root) {
  const ids = [];
  if (!activeLiveTasks) return ids;
  const want = path.resolve(root);
  for (const [id, lt] of activeLiveTasks) if (path.resolve(lt.cwd) === want) ids.push(id);
  return ids;
}

const USAGE_HOLD_HINT =
  "Usage is above 'pause above': automatic Tasks wait until the window resets or usage drops below it. "
  + 'Retry after hold.resetsAt; never run claude -p directly instead. GET /admin/usage-hold reads the hold.';

/**
 * @param {{ registerRoute: Function }} adminHttp
 * @param {{ taskSwitch?: any, resolveInfo?: Function, sessionSlots?: any, runTask?: Function,
 *   buildTaskArgs?: Function, buildTaskEnv?: Function, ledger?: any, costOfUsage?: Function,
 *   now?: () => number, randomUUID?: () => string, resolveProjectRoot?: Function,
 *   syncInteractiveReserve?: () => any, knownMcpServers?: (cwd?: string) => Record<string, object>, mcpHome?: string,
 *   usageHold?: () => any, appendAuditEvent?: (kind: string, fields: Record<string, any>) => void,
 *   switchRouteDeps?: Record<string, any> }} [deps]
 */
function registerAdminRoute(adminHttp, deps = {}) {
  registerTaskSwitchRoute(adminHttp, deps.switchRouteDeps || {});
  // Lazy defaults: agentLibrary / slots / spawn pull in heavy modules.
  const taskSwitch = () => deps.taskSwitch || require('./taskSwitch.cjs');
  const resolveInfo = deps.resolveInfo || defaultResolveInfo;
  const slots = () => deps.sessionSlots || require('../scheduler/sessionSlots.cjs');
  const taskRun = () => require('./taskRun.cjs');
  const runTask = (/** @type {any} */ o) => (deps.runTask || taskRun().runTask)(o);
  const buildArgs = (/** @type {any} */ o) => (deps.buildTaskArgs || taskRun().buildTaskArgs)(o);
  const buildEnv = (/** @type {any} */ rt, /** @type {any} */ env) => (deps.buildTaskEnv || taskRun().buildTaskEnv)(rt, env);
  const ledger = () => deps.ledger || require('./taskLedger.cjs');
  // The servers a declared `mcpServers:` name may resolve to — the same map a job gets.
  const knownMcpServers = deps.knownMcpServers || ((/** @type {string} */ cwd) => {
    const { resolveHeadlessMcpServers } = require('../claude/headlessMcpServers.cjs');
    return resolveHeadlessMcpServers({ cwd, ...(deps.mcpHome ? { home: deps.mcpHome } : {}) }).known;
  });
  const costOfUsage = (/** @type {any} */ m, /** @type {any} */ b) => (deps.costOfUsage || require('../claude/modelPricing.cjs').costOfUsage)(m, b);
  const now = deps.now || Date.now;
  const newId = deps.randomUUID || (() => crypto.randomUUID());
  const projectRoot = deps.resolveProjectRoot || resolveProjectRoot;
  // The switch file can change outside the renderer IPC (e.g. a direct module
  // call); re-sync the held interactive slot from it on every switch check.
  // setInteractiveReserve is a no-op when unchanged, so this is cheap.
  const syncReserve = deps.syncInteractiveReserve || (() => require('./taskSwitch.cjs').syncInteractiveReserve());
  const safeSync = () => {
    try { syncReserve(); } catch { /* a failed sync never changes the response */ }
  };
  // The usage hold ('pause above'): read lazily so scheduler.cjs never loads at module load.
  const usageHold = deps.usageHold || (() => require('../../scheduler.cjs').currentUsageHold());
  const audit = (/** @type {string} */ kind, /** @type {Record<string, any>} */ fields) =>
    (deps.appendAuditEvent || require('../telemetry/auditLog.cjs').appendAuditEvent)(kind, fields);
  /** project root → holdIdentityKey of the hold last audited for it; cleared when a read returns null. */
  const heldAudited = new Map();
  /** @param {string} root @param {any} hold */
  const auditHold = (root, hold) => {
    try {
      const key = require('../../scheduler/utilizationHold.cjs').holdIdentityKey(hold);
      if (heldAudited.get(root) === key) return;
      heldAudited.set(root, key);
      audit('task_usage_held', {
        cwd: root, reason: hold.reason, window: hold.window, percent: hold.percent,
        threshold: hold.threshold, resetsAt: hold.resetsAt,
      });
    } catch { /* an audit failure never changes the response */ }
  };
  /** @param {string} root @returns {any} the hold, or null; throws when the read throws. */
  const readHold = (root) => {
    const hold = usageHold();
    if (!hold) { heldAudited.delete(root); return null; }
    auditHold(root, hold);
    return hold;
  };

  /** sessionId → taskId for every Task currently between its start line and its end line. */
  const busySessions = new Map();
  /**
   * taskId → its live output for every POST /admin/tasks run between its
   * ledger start line and the end of the handler (removed in finally, after
   * the end line). In-process only: never persisted.
   * @type {Map<string, LiveTask & { append: (line: string) => void }>}
   */
  const liveTasks = new Map();
  const liveCap = () => Number(taskRun().MAX_STDOUT_BYTES) || 8 * 1024 * 1024;
  /** @param {string} id @param {string} root */
  const liveFor = (id, root) => {
    const lt = liveTasks.get(id);
    return lt && path.resolve(lt.cwd) === path.resolve(root) ? lt : null;
  };
  activeLiveTasks = liveTasks;

  adminHttp.registerRoute('POST', '/admin/tasks', async (/** @type {any} */ req, /** @type {any} */ res) => {
    try { if (typeof res.setTimeout === 'function') res.setTimeout(0); } catch { /* */ }
    try { if (typeof req.setTimeout === 'function') req.setTimeout(0); } catch { /* */ }

    let replied = false;
    // Stream mode: set once the 200 NDJSON head is written (after the ledger start line).
    let streaming = false;
    const canWrite = () => !(res.writableEnded || res.destroyed);
    const writeLine = (/** @type {any} */ obj) => { if (canWrite()) res.write(JSON.stringify(obj) + '\n'); };
    const reply = (/** @type {number} */ status, /** @type {any} */ obj) => {
      if (replied) return;
      replied = true;
      if (!canWrite()) return;
      if (streaming) {
        writeLine({ type: 'sm_task_result', ...obj });
        res.end();
        return;
      }
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

    safeSync();
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
      const declaredMcpServers = Array.isArray(info.declaredMcpServers) ? info.declaredMcpServers : [];
      args = buildArgs({ model, effort, runtime: argsRuntime, projectCwd: cwd, declaredMcpServers, knownMcpServers: knownMcpServers(cwd), skillDeny: Array.isArray(info.skillDeny) ? info.skillDeny : [] });
    } catch (e) {
      reply(400, { ok: false, error: (e && /** @type {any} */ (e).code) || 'invalid_request', details: e instanceof Error ? e.message : String(e) });
      return;
    }
    const env = buildEnv(runtime, process.env);

    // Last check before the ledger start line: the usage hold.
    let heldNow;
    try {
      heldNow = readHold(cwd);
    } catch (e) {
      reply(503, { ok: false, error: 'usage_hold_error', details: e instanceof Error ? e.message : String(e) });
      return;
    }
    if (heldNow) {
      reply(429, usageHeldBody(heldNow, USAGE_HOLD_HINT));
      return;
    }

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
      const live = newLiveTask(cwd, liveCap());
      liveTasks.set(taskId, live);

      if (input.stream === true && canWrite()) {
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store' });
        streaming = true;
        writeLine({ type: 'sm_task_started', taskId, model, effort, sessionId, startedAt });
      }

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
        const errWaitMs = now() - waitStart;
        await end({ status: code, slotWaitMs: errWaitMs });
        reply(code === 'too_many_waiting' ? 429 : 500, streaming ? { ok: false, error: code, taskId, slotWaitMs: errWaitMs } : { ok: false, error: code, taskId });
        return;
      }
      const slotWaitMs = now() - waitStart;
      if (token == null) {
        const status = ac.signal.aborted ? 'caller_gone' : 'slot_timeout';
        await end({ status, slotWaitMs });
        reply(503, { ok: false, error: status, taskId, slotWaitMs });
        return;
      }

      // The hold may have engaged while this Task waited for its slot.
      // A failed read is fail-closed but is not a hold: 503 usage_hold_error, never 429.
      let heldLate;
      try {
        heldLate = readHold(cwd);
      } catch (e) {
        try { slots().release(token); } catch { /* */ }
        await end({ status: 'usage_held', slotWaitMs });
        reply(503, { ok: false, error: 'usage_hold_error', taskId, slotWaitMs, details: e instanceof Error ? e.message : String(e) });
        return;
      }
      if (heldLate) {
        try { slots().release(token); } catch { /* */ }
        await end({ status: 'usage_held', slotWaitMs });
        reply(429, { ...usageHeldBody(heldLate, USAGE_HOLD_HINT), taskId, slotWaitMs });
        return;
      }

      live.slotAcquired = true;

      let droppedLines = 0;
      if (streaming) writeLine({ type: 'sm_task_running', slotWaitMs });
      // One callback for every run: the live registry, and in stream mode the NDJSON line too.
      const onStdoutLine = (/** @type {string} */ line) => {
        live.append(line);
        if (streaming) {
          if (!canWrite()) return;
          if ((res.writableLength || 0) > MAX_STREAM_BUFFER_BYTES) { droppedLines += 1; return; }
          let isObject = false;
          try {
            const v = JSON.parse(line);
            isObject = v !== null && typeof v === 'object' && !Array.isArray(v);
          } catch { /* not JSON → wrapped */ }
          if (isObject) res.write(line + '\n');
          else writeLine({ type: 'sm_task_stdout', text: line });
        }
      };

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
          onStdoutLine,
          taskId,
          projectRoot: cwd,
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
      const result = {
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
      };
      reply(200, streaming ? { ...result, droppedLines } : result);
    } finally {
      if (sessionId && busySessions.get(sessionId) === taskId) busySessions.delete(sessionId);
      liveTasks.delete(taskId);
      req.removeListener('close', onClose);
      res.removeListener('close', onClose);
    }
  });

  /** @returns {string} the project root, or throws when `cwd` is not one. */
  const rootOf = (/** @type {string} */ cwd) => {
    const root = projectRoot(cwd, { opsInternal: 'refuse' });
    if (path.resolve(root) !== path.resolve(cwd)) throw new Error(`cwd is not a project root (its root is "${root}")`);
    return root;
  };

  adminHttp.registerRoute('GET', '/admin/tasks', async (/** @type {any} */ _req, /** @type {any} */ res, /** @type {any} */ query) => {
    const parsed = listQuerySchema.safeParse(Object.fromEntries(query ?? []));
    if (!parsed.success) {
      sendJson(res, 400, { ok: false, error: 'invalid_request', details: parsed.error.issues });
      return;
    }
    const { cwd: rawCwd, ...filters } = parsed.data;
    let cwd;
    try { cwd = rootOf(rawCwd); } catch (e) {
      sendJson(res, 400, { ok: false, error: 'invalid_request', details: e instanceof Error ? e.message : String(e) });
      return;
    }
    try {
      // A Task this app is still running folds 'running' in the ledger, before its status filter and paging.
      const r = await ledger().listTasks(cwd, { ...filters, now: now(), liveTaskIds: liveTaskIdsFor(cwd) });
      const tasks = r.tasks.map((/** @type {any} */ t) => publicTask(t));
      sendJson(res, 200, { ok: true, tasks, total: r.total, hasMore: r.hasMore });
    } catch (e) {
      sendJson(res, 500, { ok: false, error: 'ledger_read_failed', details: e instanceof Error ? e.message : String(e) });
    }
  });

  adminHttp.registerRoute('GET', '/admin/task', async (/** @type {any} */ _req, /** @type {any} */ res, /** @type {any} */ query) => {
    const parsed = getQuerySchema.safeParse(Object.fromEntries(query ?? []));
    if (!parsed.success) {
      sendJson(res, 400, { ok: false, error: 'invalid_request', details: parsed.error.issues });
      return;
    }
    let cwd;
    try { cwd = rootOf(parsed.data.cwd); } catch (e) {
      sendJson(res, 400, { ok: false, error: 'invalid_request', details: e instanceof Error ? e.message : String(e) });
      return;
    }
    let t;
    try {
      t = await ledger().getTask(cwd, parsed.data.id, { now: now(), liveTaskIds: liveTaskIdsFor(cwd) });
    } catch (e) {
      sendJson(res, 500, { ok: false, error: 'ledger_read_failed', details: e instanceof Error ? e.message : String(e) });
      return;
    }
    if (!t) {
      sendJson(res, 404, { ok: false, error: 'unknown_task', id: parsed.data.id });
      return;
    }
    const body = t.body || {};
    const after = parsed.data.after || 0;
    const live = liveFor(parsed.data.id, cwd);
    if (live) {
      const page = livePage(live, after);
      sendJson(res, 200, {
        ok: true,
        task: {
          ...publicTask(t),
          prompt: typeof body.prompt === 'string' ? body.prompt : null,
          promptTruncated: body.promptTruncated === true,
          output: page.output,
          outputTruncated: page.outputTruncated,
          stderrTail: null,
          envelope: null,
          live: { slotAcquired: live.slotAcquired, outputEnd: page.outputEnd, outputCapped: live.outputCapped },
        },
      });
      return;
    }
    const storedOutput = typeof body.output === 'string' ? body.output : null;
    sendJson(res, 200, {
      ok: true,
      task: {
        ...publicTask(t),
        prompt: typeof body.prompt === 'string' ? body.prompt : null,
        promptTruncated: body.promptTruncated === true,
        output: storedOutput !== null && after > 0 ? sliceFromByte(storedOutput, after) : storedOutput,
        outputTruncated: body.outputTruncated === true,
        stderrTail: typeof body.stderrTail === 'string' ? body.stderrTail : null,
        envelope: body.envelope === undefined ? null : body.envelope,
        live: null,
      },
    });
  });

  /** project root → tail of its import chain: concurrent imports of one project run one at a time (dedupe stays exact). */
  const importChains = new Map();

  adminHttp.registerRoute('POST', '/admin/tasks/import', async (/** @type {any} */ req, /** @type {any} */ res) => {
    let raw;
    try {
      raw = await readBody(req, MAX_IMPORT_BODY_BYTES);
    } catch (e) {
      sendJson(res, 400, { ok: false, error: 'invalid_request', details: e instanceof Error ? e.message : String(e) });
      return;
    }
    let json;
    try { json = JSON.parse(raw || '{}'); } catch {
      sendJson(res, 400, { ok: false, error: 'invalid_request', details: 'body is not valid JSON' });
      return;
    }
    const parsed = importBodySchema.safeParse(json);
    if (!parsed.success) {
      sendJson(res, 400, { ok: false, error: 'invalid_request', details: parsed.error.issues });
      return;
    }
    let cwd;
    try { cwd = rootOf(parsed.data.cwd); } catch (e) {
      sendJson(res, 400, { ok: false, error: 'invalid_request', details: e instanceof Error ? e.message : String(e) });
      return;
    }
    safeSync();
    if (!taskSwitch().isTaskSwitchOn(cwd)) {
      sendJson(res, 403, { ok: false, error: 'tasks_disabled', hint: SWITCH_HINT });
      return;
    }

    const work = async () => {
      let imported = 0;
      let alreadyImported = 0;
      /** @type {{ index: number, error: string }[]} */
      const rejected = [];
      const seen = new Set();
      const records = parsed.data.records;
      for (let index = 0; index < records.length; index += 1) {
        const r = importRecordSchema.safeParse(records[index]);
        if (!r.success) { rejected.push({ index, error: issueText(r.error) }); continue; }
        const rec = r.data;
        try {
          if (seen.has(rec.importId) || await ledger().hasImport(cwd, rec.importId)) {
            alreadyImported += 1;
            continue;
          }
          seen.add(rec.importId);
          const startedMs = Date.parse(rec.startedAt);
          const priced = rec.usage ? costFor(rec.model, { usage: rec.usage }, costOfUsage) : null;
          const callerCost = typeof rec.costUsd === 'number' ? rec.costUsd : null;
          await ledger().appendImported(cwd, {
            taskId: newId(),
            importId: rec.importId,
            importedAt: new Date(now()).toISOString(),
            agent: rec.agent ?? null,
            missionId: rec.missionId,
            model: rec.model,
            effort: rec.effort ?? null,
            caller: rec.caller ?? {},
            startedAt: new Date(startedMs).toISOString(),
            endedAt: new Date(startedMs + rec.durationMs).toISOString(),
            durationMs: rec.durationMs,
            status: rec.status,
            exitCode: rec.exitCode ?? null,
            usage: rec.usage ?? null,
            costUsd: rec.usage ? (priced ?? callerCost) : callerCost,
            cliCostUsd: callerCost,
            sessionId: rec.sessionId ?? null,
            persisted: rec.persisted === true,
            prompt: rec.prompt ?? '',
            output: rec.output ?? '',
            envelope: rec.envelope === undefined ? null : rec.envelope,
          });
          imported += 1;
        } catch (e) {
          rejected.push({ index, error: e instanceof Error ? e.message : String(e) });
        }
      }
      return { ok: true, imported, alreadyImported, rejected };
    };

    const prev = importChains.get(cwd) || Promise.resolve();
    const next = prev.catch(() => {}).then(work);
    importChains.set(cwd, next);
    try {
      sendJson(res, 200, await next);
    } catch (e) {
      sendJson(res, 500, { ok: false, error: 'import_failed', details: e instanceof Error ? e.message : String(e) });
    } finally {
      if (importChains.get(cwd) === next) importChains.delete(cwd);
    }
  });
}

module.exports = {
  registerAdminRoute, liveTaskIdsFor, MAX_BODY_BYTES, MAX_IMPORT_BODY_BYTES, TASK_FIELDS, IMPORT_STATUSES,
  TASK_BODY_KEYS, TASK_RUNTIME_KEYS, TASK_GET_KEYS,
};

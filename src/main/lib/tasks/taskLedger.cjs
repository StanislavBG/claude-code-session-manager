'use strict';

/**
 * taskLedger.cjs — the Task ledger: THE ONLY WRITER of a project's
 * `session-manager-operations/tasks/` namespace (writer id 'tasks' in
 * lib/opsOwnership.cjs) and the read model routes, IPC and history use.
 *
 * A Task is one headless `claude -p` run made for one project.
 *
 * Layout (all paths via opsPath(cwd, 'tasks', ...)):
 *   tasks/<YYYY-MM-DD>.jsonl   summary lines, local date of the Task's startedAt.
 *                              Event-log shaped {domain}.{action} kinds:
 *                              'task.started' (from null → to 'running') and
 *                              'task.status_changed' (from → to; an end, or a
 *                              whole imported Task with importId, from null).
 *                              Legacy 'start' | 'end' | 'imported' lines still
 *                              on disk are read as those two kinds. Hashes + byte
 *                              counts only — never prompt/output text. Every
 *                              line carries sessionId (claude session id or
 *                              null) and persisted (true when the run kept its
 *                              transcript; listPersistedSessionIds reads it).
 *   tasks/bodies/<taskId>.json prompt/output text (each capped at 1 MiB, with
 *                              promptTruncated/outputTruncated), stderrTail,
 *                              envelope. Written via atomicFs.writeJsonAtomic.
 *
 * Status legality: every status line goes through transitionTask(from, to)
 * against TASK_LEGAL_TRANSITIONS — refuse-plus-audit, like
 * scheduler/scheduleJobTransitions.cjs. An illegal edge throws under vitest
 * and, in prod, is refused (no line written, the call resolves null) with a
 * `task_transition_refused` audit record. The read-side timeout derivation
 * (running → interrupted) goes through the same table.
 *
 * Retention: opsRetentionSettings.read().tasksDays (default 30). pruneOld runs
 * once per local day per project, on the first append of that day.
 *
 * Concurrency: appends to one day file are serialized by an in-process
 * promise chain keyed by file path. Reads never throw on a bad line — the
 * line is skipped and counted in `skippedLines`.
 */

const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { opsPath, assertOpsWrite } = require('../opsOwnership.cjs');
const atomicFs = require('../util/atomicFs.cjs');

const WRITER = 'tasks';
const NS = 'tasks';
const BODY_CAP_BYTES = 1024 * 1024;
const INTERRUPT_GRACE_MS = 120000;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const DAY_MS = 86400000;
const DAY_FILE_RE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;
const TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const KIND_STARTED = 'task.started';
const KIND_STATUS_CHANGED = 'task.status_changed';
const KINDS = new Set([KIND_STARTED, KIND_STATUS_CHANGED]);
/** Pre-event-log kinds still on disk (≤ tasksDays old) → their current kind. */
const LEGACY_KINDS = { start: KIND_STARTED, end: KIND_STATUS_CHANGED, imported: KIND_STATUS_CHANGED };

/** Terminal Task statuses (taskRun.cjs + taskAdminRoutes.cjs + read-side 'interrupted'). */
const TERMINAL_STATUSES = Object.freeze([
  'ok', 'error', 'rate_limited', 'timeout', 'spawn_failed', 'caller_gone', 'slot_timeout',
  'too_many_waiting', 'interrupted',
]);

/**
 * Explicit from → to edges. The key 'null' is "no prior status": a Task's
 * start (→ running), an imported whole Task, or an end whose start body is
 * gone (→ any terminal). running → any terminal, including the timeout-derived
 * 'interrupted'. Terminal statuses have no exits — a second end is refused.
 */
const TASK_LEGAL_TRANSITIONS = {
  null: ['running', ...TERMINAL_STATUSES],
  running: [...TERMINAL_STATUSES],
};
for (const s of TERMINAL_STATUSES) TASK_LEGAL_TRANSITIONS[s] = [];

let refusedTransitionCount = 0;

function isUnderTest() {
  return !!process.env.VITEST;
}

/**
 * transitionTask(from, to, { taskId, cwd, source, reason }) → boolean.
 * true when `from → to` is in TASK_LEGAL_TRANSITIONS. An illegal edge throws
 * under vitest; in prod it logs, counts, writes a `task_transition_refused`
 * audit record and returns false (the caller then refuses the write).
 */
function transitionTask(from, to, ctx = {}) {
  const key = from == null ? 'null' : String(from);
  const edges = Object.prototype.hasOwnProperty.call(TASK_LEGAL_TRANSITIONS, key) ? TASK_LEGAL_TRANSITIONS[key] : null;
  if (Array.isArray(edges) && edges.includes(to)) return true;
  const detail = {
    taskId: ctx.taskId ?? null,
    from: from ?? null,
    to: to ?? null,
    source: ctx.source ?? null,
    reason: ctx.reason ?? null,
    cwd: ctx.cwd ?? null,
  };
  if (isUnderTest()) {
    throw new Error(`taskLedger: illegal task transition ${detail.from} -> ${detail.to} (taskId=${detail.taskId})`);
  }
  refusedTransitionCount += 1;
  console.error(`[taskLedger] illegal transition refused: taskId=${detail.taskId} from=${detail.from} to=${detail.to} source=${detail.source}`);
  try {
    require('../telemetry/auditLog.cjs').appendAuditEvent('task_transition_refused', detail);
  } catch { /* auditing must never be the thing that fails */ }
  return false;
}

function getRefusedTransitionCount() { return refusedTransitionCount; }
// Text-bearing input fields: they go to the body file, never the summary line.
const TEXT_FIELDS = ['prompt', 'output', 'stderrTail', 'envelope'];
const USAGE_KEYS = ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'];

/** file path → tail of its append chain. */
const chains = new Map();
/** project ops dir → local date pruneOld last ran for it. */
const prunedOn = new Map();

function localDate(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function toMs(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v) {
    const ms = Date.parse(v);
    if (Number.isFinite(ms)) return ms;
  }
  return null;
}

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/** { text (≤ 1 MiB), truncated, bytes (full), sha256 (full) } for a string-ish value. */
function capText(value) {
  const text = typeof value === 'string' ? value : value == null ? '' : String(value);
  const buf = Buffer.from(text, 'utf8');
  const truncated = buf.length > BODY_CAP_BYTES;
  return {
    text: truncated ? buf.subarray(0, BODY_CAP_BYTES).toString('utf8') : text,
    truncated,
    bytes: buf.length,
    sha256: sha256(text),
  };
}

function assertTaskId(taskId) {
  if (typeof taskId !== 'string' || !TASK_ID_RE.test(taskId)) {
    throw new Error(`taskLedger: invalid taskId "${taskId}"`);
  }
}

function tasksDir(cwd) { return opsPath(cwd, NS); }
function dayFile(cwd, date) { return opsPath(cwd, NS, `${date}.jsonl`); }
function bodyFile(cwd, taskId) { return opsPath(cwd, NS, 'bodies', `${taskId}.json`); }

function stripText(row) {
  const out = { ...row };
  for (const k of TEXT_FIELDS) delete out[k];
  return out;
}

/** sessionId (non-empty string, else null) + persisted (true only when === true). */
function sessionFields(row) {
  return {
    sessionId: typeof row.sessionId === 'string' && row.sessionId ? row.sessionId : null,
    persisted: row.persisted === true,
  };
}

function appendLine(file, obj) {
  assertOpsWrite(file, WRITER);
  const line = `${JSON.stringify(obj)}\n`;
  const prev = chains.get(file) || Promise.resolve();
  const next = prev.catch(() => {}).then(async () => {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.appendFile(file, line, 'utf8');
  });
  chains.set(file, next);
  const cleanup = () => { if (chains.get(file) === next) chains.delete(file); };
  next.then(cleanup, cleanup);
  return next;
}

async function writeBody(cwd, taskId, body) {
  const file = bodyFile(cwd, taskId);
  assertOpsWrite(file, WRITER);
  await atomicFs.writeJsonAtomic(file, body);
}

async function readBody(cwd, taskId) {
  const body = await atomicFs.readJsonOr(bodyFile(cwd, taskId), null);
  return body && typeof body === 'object' && !Array.isArray(body) ? body : null;
}

/** Once per local day per project, before the first append of that day. */
async function maybePrune(cwd) {
  const key = tasksDir(cwd);
  const today = localDate(Date.now());
  if (prunedOn.get(key) === today) return;
  prunedOn.set(key, today);
  try {
    await pruneOld(cwd, { now: Date.now() });
  } catch (e) {
    console.warn('[taskLedger] pruneOld failed:', e && e.message);
  }
}

function startedMsOf(row) {
  const ms = toMs(row.startedAt);
  if (ms == null) throw new Error('taskLedger: startedAt (ISO) is required');
  return ms;
}

/**
 * appendTaskStart(cwd, { ...startRow, prompt }) — writes the body (prompt) and
 * a kind 'start' summary line.
 */
async function appendTaskStart(cwd, row) {
  assertTaskId(row && row.taskId);
  const startedMs = startedMsOf(row);
  if (!transitionTask(null, 'running', { taskId: row.taskId, cwd, source: 'appendTaskStart' })) return null;
  await maybePrune(cwd);
  const p = capText(row.prompt);
  await writeBody(cwd, row.taskId, {
    v: 1,
    taskId: row.taskId,
    startedAt: row.startedAt,
    status: 'running',
    prompt: p.text,
    promptTruncated: p.truncated,
  });
  const line = {
    ...stripText(row),
    ...sessionFields(row),
    v: 1,
    kind: KIND_STARTED,
    from: null,
    to: 'running',
    source: 'sm',
    promptSha256: p.sha256,
    promptBytes: p.bytes,
  };
  await appendLine(dayFile(cwd, localDate(startedMs)), line);
  return line;
}

/**
 * appendTaskEnd(cwd, { ...endRow, output, stderrTail, envelope }) — rewrites
 * the body adding output fields and appends a kind 'end' line to the day file
 * of the Task's startedAt (taken from the row, else from the body). The edge
 * is body.status (a body without one = 'running'; no body = null) → row.status;
 * an illegal edge (e.g. a second end) is refused and resolves null.
 */
async function appendTaskEnd(cwd, row) {
  assertTaskId(row && row.taskId);
  const body = await readBody(cwd, row.taskId);
  const from = body ? (typeof body.status === 'string' && body.status ? body.status : 'running') : null;
  if (!transitionTask(from, row.status, { taskId: row.taskId, cwd, source: 'appendTaskEnd' })) return null;
  await maybePrune(cwd);
  const prior = body || { v: 1, taskId: row.taskId };
  const startedAt = row.startedAt || prior.startedAt || row.endedAt || new Date().toISOString();
  const startedMs = toMs(startedAt) ?? Date.now();
  const o = capText(row.output);
  const stderr = capText(row.stderrTail);
  await writeBody(cwd, row.taskId, {
    ...prior,
    startedAt,
    status: row.status,
    output: o.text,
    outputTruncated: o.truncated,
    stderrTail: stderr.text,
    envelope: row.envelope === undefined ? null : row.envelope,
  });
  const line = {
    ...stripText(row),
    ...sessionFields(row),
    v: 1,
    kind: KIND_STATUS_CHANGED,
    from,
    to: row.status,
    startedAt,
    outputSha256: o.sha256,
    outputBytes: o.bytes,
  };
  await appendLine(dayFile(cwd, localDate(startedMs)), line);
  return line;
}

/**
 * appendImported(cwd, { ...start+end fields, importId, prompt, output, ... }) —
 * one kind 'imported' line (source 'direct') carrying the whole Task.
 */
async function appendImported(cwd, row) {
  assertTaskId(row && row.taskId);
  if (typeof row.importId !== 'string' || !row.importId) throw new Error('taskLedger: importId is required');
  const startedMs = startedMsOf(row);
  if (!transitionTask(null, row.status, { taskId: row.taskId, cwd, source: 'appendImported' })) return null;
  await maybePrune(cwd);
  const p = capText(row.prompt);
  const o = capText(row.output);
  const stderr = capText(row.stderrTail);
  await writeBody(cwd, row.taskId, {
    v: 1,
    taskId: row.taskId,
    startedAt: row.startedAt,
    status: row.status,
    prompt: p.text,
    promptTruncated: p.truncated,
    output: o.text,
    outputTruncated: o.truncated,
    stderrTail: stderr.text,
    envelope: row.envelope === undefined ? null : row.envelope,
  });
  const line = {
    ...stripText(row),
    ...sessionFields(row),
    v: 1,
    kind: KIND_STATUS_CHANGED,
    from: null,
    to: row.status,
    source: 'direct',
    promptSha256: p.sha256,
    promptBytes: p.bytes,
    outputSha256: o.sha256,
    outputBytes: o.bytes,
  };
  await appendLine(dayFile(cwd, localDate(startedMs)), line);
  return line;
}

// ─── Reads ────────────────────────────────────────────────────────────────

async function listDayFiles(cwd, { sinceDate, untilDate } = {}) {
  let names;
  try {
    names = await fsp.readdir(tasksDir(cwd));
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
  const out = [];
  for (const n of names) {
    const m = DAY_FILE_RE.exec(n);
    if (!m) continue;
    if (sinceDate && m[1] < sinceDate) continue;
    if (untilDate && m[1] > untilDate) continue;
    out.push({ date: m[1], file: dayFile(cwd, m[1]) });
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/** Parsed, valid rows of the selected day files + the count of skipped lines. */
async function readRows(cwd, range) {
  const rows = [];
  let skippedLines = 0;
  for (const { file } of await listDayFiles(cwd, range)) {
    let text;
    try {
      text = await fsp.readFile(file, 'utf8');
    } catch (e) {
      if (e.code === 'ENOENT') continue;
      throw e;
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let row;
      try { row = JSON.parse(line); } catch { skippedLines += 1; continue; }
      if (row && typeof row === 'object' && !Array.isArray(row)
        && Object.prototype.hasOwnProperty.call(LEGACY_KINDS, row.kind)) {
        row = { ...row, kind: LEGACY_KINDS[row.kind] };
      }
      if (!row || typeof row !== 'object' || Array.isArray(row)
        || !KINDS.has(row.kind) || typeof row.taskId !== 'string' || !row.taskId) {
        skippedLines += 1;
        continue;
      }
      rows.push(row);
    }
  }
  return { rows, skippedLines };
}

/**
 * A Task's status: its end/imported status, else 'running' — or, once
 * startedAt + timeoutSec + grace has passed, the timeout-derived
 * 'interrupted', taken only when TASK_LEGAL_TRANSITIONS allows running → it.
 */
function foldedStatus(t, now) {
  if (t.status) return t.status;
  const startedMs = toMs(t.startedAt);
  const timeoutMs = (Number(t.timeoutSec) || 0) * 1000;
  if (startedMs != null && now > startedMs + timeoutMs + INTERRUPT_GRACE_MS
    && transitionTask('running', 'interrupted', { taskId: t.taskId, source: 'foldedStatus:timeout' })) {
    return 'interrupted';
  }
  return 'running';
}

/** taskId → folded Task (start ⊕ end, or the imported line). */
function fold(rows, now) {
  const byId = new Map();
  for (const row of rows) {
    const { kind, from: _from, to: _to, ...fields } = row;
    const cur = byId.get(row.taskId);
    if (kind === KIND_STATUS_CHANGED && typeof fields.importId === 'string' && fields.importId) {
      byId.set(row.taskId, { ...(cur || {}), ...fields });
    } else if (kind === KIND_STATUS_CHANGED) {
      // An end never erases start fields it doesn't carry — nor the start's
      // sessionId/persisted with its own null/false defaults.
      byId.set(row.taskId, {
        ...(cur || {}),
        ...fields,
        startedAt: (cur && cur.startedAt) || fields.startedAt,
        sessionId: fields.sessionId || (cur && cur.sessionId) || null,
        persisted: fields.persisted === true || (cur && cur.persisted === true) || false,
      });
    } else {
      byId.set(row.taskId, cur ? { ...fields, ...cur } : { ...fields });
    }
  }
  const tasks = [];
  for (const t of byId.values()) {
    tasks.push({ ...t, ...sessionFields(t), status: foldedStatus(t, now) });
  }
  tasks.sort((a, b) => (toMs(b.startedAt) ?? 0) - (toMs(a.startedAt) ?? 0));
  return tasks;
}

function matches(t, f) {
  const caller = t.caller || {};
  if (f.pipeline != null && caller.pipeline !== f.pipeline) return false;
  if (f.runId != null && caller.runId !== f.runId) return false;
  if (f.step != null && caller.step !== f.step) return false;
  if (f.agent != null && t.agent !== f.agent) return false;
  if (f.status != null && t.status !== f.status) return false;
  if (f.source != null && t.source !== f.source) return false;
  const ms = toMs(t.startedAt);
  if (f.sinceMs != null && (ms == null || ms < f.sinceMs)) return false;
  if (f.untilMs != null && (ms == null || ms > f.untilMs)) return false;
  return true;
}

/**
 * listTasks(cwd, { since, until, pipeline, runId, step, agent, status, source,
 * limit = 50 (max 200), offset = 0, now }) → { tasks, total, hasMore, skippedLines }.
 * Newest first by startedAt. `since`/`until` are ISO timestamps (inclusive).
 */
async function listTasks(cwd, opts = {}) {
  const o = opts || {};
  const now = typeof o.now === 'number' ? o.now : Date.now();
  const sinceMs = toMs(o.since);
  const untilMs = toMs(o.until);
  const range = {
    sinceDate: sinceMs != null ? localDate(sinceMs) : undefined,
    untilDate: untilMs != null ? localDate(untilMs) : undefined,
  };
  const { rows, skippedLines } = await readRows(cwd, range);
  const all = fold(rows, now).filter((t) => matches(t, { ...o, sinceMs, untilMs }));
  const limitRaw = Number.isFinite(Number(o.limit)) && o.limit != null ? Math.floor(Number(o.limit)) : DEFAULT_LIMIT;
  const limit = Math.min(MAX_LIMIT, Math.max(1, limitRaw));
  const offset = Math.max(0, Math.floor(Number(o.offset) || 0));
  const tasks = all.slice(offset, offset + limit);
  return { tasks, total: all.length, hasMore: offset + tasks.length < all.length, skippedLines };
}

/** getTask(cwd, taskId, { now }) → folded Task with `body` (or body:null), or null. */
async function getTask(cwd, taskId, opts = {}) {
  if (typeof taskId !== 'string' || !TASK_ID_RE.test(taskId)) return null;
  const now = typeof (opts && opts.now) === 'number' ? opts.now : Date.now();
  const { rows } = await readRows(cwd);
  const mine = rows.filter((r) => r.taskId === taskId);
  if (mine.length === 0) return null;
  const [task] = fold(mine, now);
  return { ...task, body: await readBody(cwd, taskId) };
}

/** hasImport(cwd, importId) → true when an 'imported' line with that importId exists. */
async function hasImport(cwd, importId) {
  if (typeof importId !== 'string' || !importId) return false;
  const { rows } = await readRows(cwd);
  return rows.some((r) => r.kind === KIND_STATUS_CHANGED && r.importId === importId);
}

/**
 * readTaskUsageDays(cwd, { sinceDate, untilDate }) → ascending
 * [{ date, tasks, input_tokens, output_tokens, cache_read_input_tokens,
 *    cache_creation_input_tokens, costUsd, byModel }] for local dates
 * (YYYY-MM-DD, inclusive) that have at least one Task. `byModel` maps the
 * Task's `model` (or 'unknown') to { tasks, <USAGE_KEYS> } so a reader can
 * price usage per model (historyDashboard.cjs does).
 */
async function readTaskUsageDays(cwd, { sinceDate, untilDate } = {}) {
  const { rows } = await readRows(cwd, { sinceDate, untilDate });
  const days = new Map();
  for (const t of fold(rows, Date.now())) {
    const ms = toMs(t.startedAt);
    if (ms == null) continue;
    const date = localDate(ms);
    if ((sinceDate && date < sinceDate) || (untilDate && date > untilDate)) continue;
    let d = days.get(date);
    if (!d) {
      d = { date, tasks: 0, ...Object.fromEntries(USAGE_KEYS.map((k) => [k, 0])), costUsd: 0, byModel: {} };
      days.set(date, d);
    }
    d.tasks += 1;
    const model = typeof t.model === 'string' && t.model ? t.model : 'unknown';
    const m = d.byModel[model] ?? (d.byModel[model] = { tasks: 0, ...Object.fromEntries(USAGE_KEYS.map((k) => [k, 0])) });
    m.tasks += 1;
    const u = t.usage || {};
    for (const k of USAGE_KEYS) {
      const n = Number(u[k]) || 0;
      d[k] += n;
      m[k] += n;
    }
    d.costUsd += Number(t.costUsd) || 0;
  }
  return [...days.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
}

/**
 * listPersistedSessionIds(cwd) → Set of sessionId from every retained
 * 'task.started' line or imported (importId-carrying) 'task.status_changed' line with persisted === true. A start line is written before
 * the claude process spawns, so its id is here before its transcript exists.
 * Malformed lines are skipped; a missing tasks/ folder yields an empty Set.
 */
async function listPersistedSessionIds(cwd) {
  const { rows } = await readRows(cwd);
  const ids = new Set();
  for (const r of rows) {
    const isImport = r.kind === KIND_STATUS_CHANGED && typeof r.importId === 'string' && r.importId;
    if ((r.kind === KIND_STARTED || isImport) && r.persisted === true
      && typeof r.sessionId === 'string' && r.sessionId) ids.add(r.sessionId);
  }
  return ids;
}

// ─── Retention ────────────────────────────────────────────────────────────

/**
 * pruneOld(cwd, { now, maxAgeDays }) → { maxAgeDays, removedDays, removedBodies }.
 * Deletes day files dated before (now - maxAgeDays) and bodies whose mtime is
 * older than that. maxAgeDays defaults to opsRetentionSettings tasksDays.
 */
async function pruneOld(cwd, { now = Date.now(), maxAgeDays } = {}) {
  const days = Number.isFinite(maxAgeDays) && maxAgeDays > 0
    ? maxAgeDays
    : require('../opsRetentionSettings.cjs').read().tasksDays;
  const cutoffMs = now - days * DAY_MS;
  const cutoffDate = localDate(cutoffMs);
  const removedDays = [];
  for (const { date, file } of await listDayFiles(cwd)) {
    if (date >= cutoffDate) continue;
    assertOpsWrite(file, WRITER);
    await fsp.rm(file, { force: true });
    removedDays.push(date);
  }
  let removedBodies = 0;
  const bodiesDir = opsPath(cwd, NS, 'bodies');
  let names = [];
  try { names = await fsp.readdir(bodiesDir); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    const file = opsPath(cwd, NS, 'bodies', n);
    let st;
    try { st = await fsp.stat(file); } catch { continue; }
    if (st.mtimeMs >= cutoffMs) continue;
    assertOpsWrite(file, WRITER);
    await fsp.rm(file, { force: true });
    removedBodies += 1;
  }
  return { maxAgeDays: days, removedDays, removedBodies };
}

function _resetForTests() {
  chains.clear();
  prunedOn.clear();
  refusedTransitionCount = 0;
}

module.exports = {
  appendTaskStart,
  appendTaskEnd,
  appendImported,
  hasImport,
  listTasks,
  getTask,
  readTaskUsageDays,
  listPersistedSessionIds,
  pruneOld,
  transitionTask,
  getRefusedTransitionCount,
  TASK_LEGAL_TRANSITIONS,
  TERMINAL_STATUSES,
  BODY_CAP_BYTES,
  _resetForTests,
};

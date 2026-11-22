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
 *                              kind 'start' | 'end' | 'imported'. Hashes + byte
 *                              counts only — never prompt/output text.
 *   tasks/bodies/<taskId>.json prompt/output text (each capped at 1 MiB, with
 *                              promptTruncated/outputTruncated), stderrTail,
 *                              envelope. Written via atomicFs.writeJsonAtomic.
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
const KINDS = new Set(['start', 'end', 'imported']);
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
  await maybePrune(cwd);
  const p = capText(row.prompt);
  await writeBody(cwd, row.taskId, {
    v: 1,
    taskId: row.taskId,
    startedAt: row.startedAt,
    prompt: p.text,
    promptTruncated: p.truncated,
  });
  const line = {
    ...stripText(row),
    v: 1,
    kind: 'start',
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
 * of the Task's startedAt (taken from the row, else from the body).
 */
async function appendTaskEnd(cwd, row) {
  assertTaskId(row && row.taskId);
  await maybePrune(cwd);
  const prior = (await readBody(cwd, row.taskId)) || { v: 1, taskId: row.taskId };
  const startedAt = row.startedAt || prior.startedAt || row.endedAt || new Date().toISOString();
  const startedMs = toMs(startedAt) ?? Date.now();
  const o = capText(row.output);
  const stderr = capText(row.stderrTail);
  await writeBody(cwd, row.taskId, {
    ...prior,
    startedAt,
    output: o.text,
    outputTruncated: o.truncated,
    stderrTail: stderr.text,
    envelope: row.envelope === undefined ? null : row.envelope,
  });
  const line = {
    ...stripText(row),
    v: 1,
    kind: 'end',
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
  await maybePrune(cwd);
  const p = capText(row.prompt);
  const o = capText(row.output);
  const stderr = capText(row.stderrTail);
  await writeBody(cwd, row.taskId, {
    v: 1,
    taskId: row.taskId,
    startedAt: row.startedAt,
    prompt: p.text,
    promptTruncated: p.truncated,
    output: o.text,
    outputTruncated: o.truncated,
    stderrTail: stderr.text,
    envelope: row.envelope === undefined ? null : row.envelope,
  });
  const line = {
    ...stripText(row),
    v: 1,
    kind: 'imported',
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

function foldedStatus(t, now) {
  if (t.status) return t.status;
  const startedMs = toMs(t.startedAt);
  const timeoutMs = (Number(t.timeoutSec) || 0) * 1000;
  if (startedMs != null && now > startedMs + timeoutMs + INTERRUPT_GRACE_MS) return 'interrupted';
  return 'running';
}

/** taskId → folded Task (start ⊕ end, or the imported line). */
function fold(rows, now) {
  const byId = new Map();
  for (const row of rows) {
    const { kind, ...fields } = row;
    const cur = byId.get(row.taskId);
    if (kind === 'end') {
      // An end never erases start fields it doesn't carry.
      byId.set(row.taskId, { ...(cur || {}), ...fields, startedAt: (cur && cur.startedAt) || fields.startedAt });
    } else if (kind === 'start') {
      byId.set(row.taskId, cur ? { ...fields, ...cur } : { ...fields });
    } else {
      byId.set(row.taskId, { ...(cur || {}), ...fields });
    }
  }
  const tasks = [];
  for (const t of byId.values()) tasks.push({ ...t, status: foldedStatus(t, now) });
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
  return rows.some((r) => r.kind === 'imported' && r.importId === importId);
}

/**
 * readTaskUsageDays(cwd, { sinceDate, untilDate }) → ascending
 * [{ date, tasks, input_tokens, output_tokens, cache_read_input_tokens,
 *    cache_creation_input_tokens, costUsd }] for local dates (YYYY-MM-DD,
 * inclusive) that have at least one Task.
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
      d = { date, tasks: 0, ...Object.fromEntries(USAGE_KEYS.map((k) => [k, 0])), costUsd: 0 };
      days.set(date, d);
    }
    d.tasks += 1;
    const u = t.usage || {};
    for (const k of USAGE_KEYS) d[k] += Number(u[k]) || 0;
    d.costUsd += Number(t.costUsd) || 0;
  }
  return [...days.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
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
}

module.exports = {
  appendTaskStart,
  appendTaskEnd,
  appendImported,
  hasImport,
  listTasks,
  getTask,
  readTaskUsageDays,
  pruneOld,
  BODY_CAP_BYTES,
  _resetForTests,
};

'use strict';

/**
 * macroJobStatus.cjs — per built-in macro with a `job` declaration, and per
 * project Video tool (isProjectVideoTool) of this project, the state of its
 * newest background job for one project: newest live queue row, else newest
 * entry in a bounded tail of the project's scheduler history. Read-only.
 * A tool's status also carries entryId (from the video entry's review
 * dispatch.json, matched by slug); a completed review-stage run whose entry is
 * waiting on the human reports status 'awaiting_review'.
 *
 * Plain Node, no Electron imports; all I/O is injected.
 */

const { BUILTIN_MACROS } = require('./builtinMacros.cjs');
const { readTail } = require('../util/fileTail.cjs');
const { isProjectVideoTool } = require('./macroLibrary.cjs');

const HISTORY_TAIL_BYTES = 524288;
const RUNNING = new Set(['running', 'investigating']);
const FAILED = new Set(['failed', 'needs_review', 'skipped', 'cancelled']);
const REASON_MAX = 200;
const AWAITING_REVIEW = 'awaiting_review';

/** First non-empty line, at most REASON_MAX chars. */
function oneLineReason(v) {
  const line = String(v).split(/\r?\n/).map((l) => l.trim()).find(Boolean) || '';
  return line.length > REASON_MAX ? line.slice(0, REASON_MAX) : line;
}

function stateOf(status) {
  if (RUNNING.has(status)) return 'running';
  if (status === 'completed') return 'done';
  if (FAILED.has(status)) return 'failed';
  return 'queued'; // pending/held/blocked/deferred/null/unknown
}

function reasonOf(row, status) {
  if (row.verifierVerdict === 'budget_exceeded') {
    const n = row.budgetMinutes;
    return Number.isFinite(n) && n > 0 ? `Timed out at the ${n}-minute job budget` : 'Timed out at the job budget';
  }
  for (const v of [row.error, row.finalizeReason, row.terminalReason]) {
    if (typeof v === 'string' && v.trim()) return oneLineReason(v);
  }
  return `Ended as ${status}`;
}

function toStatus(macroId, row) {
  const status = row.status == null ? null : row.status;
  const state = stateOf(status);
  return {
    macroId,
    epicId: row.epicId ?? row.sourcePromptId ?? null,
    slug: row.slug ?? null,
    state,
    status,
    reason: state === 'failed' ? reasonOf(row, status) : null,
    startedAt: row.startedAt ?? null,
    finishedAt: row.finishedAt ?? null,
  };
}

function stamp(row) {
  const t = Date.parse(row.finishedAt || row.startedAt || row.createdAt || row.queuedAt || '');
  return Number.isFinite(t) ? t : 0;
}

/** Newest row of `rows` (ties: later in the list wins). */
function newest(rows) {
  let best = null;
  let bestT = -Infinity;
  for (const r of rows) {
    const t = stamp(r);
    if (t >= bestT) { best = r; bestT = t; }
  }
  return best;
}

function parseHistory(text) {
  const out = [];
  if (typeof text !== 'string' || !text) return out;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line);
      if (o && typeof o === 'object' && !o.kind) out.push(o);
    } catch { /* torn line (tail cut mid-line, partial write) */ }
  }
  return out;
}

function defaultListReviews(cwd) {
  return require('../project-pages/videoReview.cjs').listReviews(cwd);
}

function defaultReadHistoryTail(cwd) {
  const { projectHistoryPath } = require('../scheduler/queueStore.cjs');
  return readTail(projectHistoryPath(cwd), HISTORY_TAIL_BYTES);
}

async function macroJobStatuses(
  { cwd } = {},
  { loadJobs, readHistoryTail = defaultReadHistoryTail, builtins = BUILTIN_MACROS, macros = [], listReviews = defaultListReviews } = {},
) {
  const jobBuiltins = (builtins || []).filter((m) => m && m.job && m.id);
  const builtinIds = new Set(jobBuiltins.map((m) => m.id));
  const tools = (Array.isArray(macros) ? macros : [])
    .filter((m) => m && m.id && !m.builtin && !builtinIds.has(m.id) && isProjectVideoTool(m, cwd));
  const all = [...jobBuiltins.map((m) => ({ m, tool: false })), ...tools.map((m) => ({ m, tool: true }))];
  if (!all.length) return [];
  let live = [];
  try {
    const rows = typeof loadJobs === 'function' ? await loadJobs() : [];
    live = Array.isArray(rows) ? rows.filter((r) => r && r.cwd === cwd && r.macroId) : [];
  } catch { live = []; }

  let history = null; // lazily read once, only if some macro has no live row
  const loadHistory = async () => {
    if (history) return history;
    try {
      history = parseHistory(await readHistoryTail(cwd)).filter((r) => r.macroId && (!r.cwd || r.cwd === cwd));
    } catch { history = []; }
    return history;
  };

  let reviews = null; // lazily read once, only if some tool has a row
  const loadReviews = async () => {
    if (reviews) return reviews;
    try {
      const list = typeof listReviews === 'function' ? await listReviews(cwd) : [];
      reviews = Array.isArray(list) ? list.filter((r) => r && r.dispatch && typeof r.dispatch.slug === 'string' && r.dispatch.slug) : [];
    } catch { reviews = []; }
    return reviews;
  };

  const out = [];
  for (const { m, tool } of all) {
    let row = newest(live.filter((r) => r.macroId === m.id));
    if (!row) row = newest((await loadHistory()).filter((r) => r.macroId === m.id));
    if (!row) continue;
    const st = toStatus(m.id, row);
    if (tool) {
      const review = row.slug ? (await loadReviews()).find((r) => r.dispatch.slug === row.slug) : null;
      st.entryId = review ? review.entryId : null;
      if (review && row.status === 'completed' && review.dispatch.stage === 'review' && review.status === 'waiting') {
        st.status = AWAITING_REVIEW;
      }
    }
    out.push(st);
  }
  return out;
}

/**
 * Per run slug, the job state of that run: the newest live queue row for cwd,
 * else the newest row in the project's history tail (read at most once).
 * Value is null when no row with that slug exists for cwd. Never throws.
 */
async function jobStatusesBySlug({ cwd, slugs } = {}, { loadJobs, readHistoryTail = defaultReadHistoryTail } = {}) {
  const wanted = [...new Set((Array.isArray(slugs) ? slugs : []).filter((s) => typeof s === 'string' && s))];
  if (!wanted.length) return {};
  const set = new Set(wanted);
  let live = [];
  try {
    const rows = typeof loadJobs === 'function' ? await loadJobs() : [];
    live = Array.isArray(rows) ? rows.filter((r) => r && r.cwd === cwd && set.has(r.slug)) : [];
  } catch { live = []; }

  let history = null; // lazily read once, only if some slug has no live row
  const loadHistory = async () => {
    if (history) return history;
    try {
      history = parseHistory(await readHistoryTail(cwd)).filter((r) => set.has(r.slug) && (!r.cwd || r.cwd === cwd));
    } catch { history = []; }
    return history;
  };

  const out = {};
  for (const slug of wanted) {
    let row = newest(live.filter((r) => r.slug === slug));
    if (!row) row = newest((await loadHistory()).filter((r) => r.slug === slug));
    if (!row) { out[slug] = null; continue; }
    const { state, status, reason, startedAt, finishedAt } = toStatus(row.macroId ?? null, row);
    out[slug] = { slug, state, status, reason, startedAt, finishedAt };
  }
  return out;
}

module.exports = { macroJobStatuses, jobStatusesBySlug, HISTORY_TAIL_BYTES, REASON_MAX, AWAITING_REVIEW };

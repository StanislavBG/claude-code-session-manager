'use strict';

/**
 * macroJobStatus.cjs — per built-in macro with a `job` declaration, the state of
 * its newest background job for one project: newest live queue row, else newest
 * entry in a bounded tail of the project's scheduler history. Read-only.
 *
 * Plain Node, no Electron imports; all I/O is injected.
 */

const { BUILTIN_MACROS } = require('./builtinMacros.cjs');
const { readTail } = require('../util/fileTail.cjs');

const HISTORY_TAIL_BYTES = 524288;
const RUNNING = new Set(['running', 'investigating']);
const FAILED = new Set(['failed', 'needs_review', 'skipped', 'cancelled']);

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
    if (typeof v === 'string' && v.trim()) return v;
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

function defaultReadHistoryTail(cwd) {
  const { projectHistoryPath } = require('../scheduler/queueStore.cjs');
  return readTail(projectHistoryPath(cwd), HISTORY_TAIL_BYTES);
}

async function macroJobStatuses({ cwd } = {}, { loadJobs, readHistoryTail = defaultReadHistoryTail, builtins = BUILTIN_MACROS } = {}) {
  const macros = (builtins || []).filter((m) => m && m.job && m.id);
  if (!macros.length) return [];
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

  const out = [];
  for (const m of macros) {
    let row = newest(live.filter((r) => r.macroId === m.id));
    if (!row) row = newest((await loadHistory()).filter((r) => r.macroId === m.id));
    if (row) out.push(toStatus(m.id, row));
  }
  return out;
}

module.exports = { macroJobStatuses, HISTORY_TAIL_BYTES };

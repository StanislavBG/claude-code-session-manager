/**
 * Durable daily history rollup — persists per (localDate, projectDir, modelId)
 * scalar aggregates to `~/.claude/session-manager/history-rollup.jsonl` so
 * closed (pre-today) History dashboard days survive an Electron restart and
 * transcript retention/cleanup, instead of being recomputed from raw .jsonl
 * transcripts every cold start.
 *
 * Storage shape: one JSON line per bucket. Lines are append-only; the latest
 * line for a given key wins (last-write-wins), so backfill/re-finalize simply
 * appends a corrected line rather than rewriting history. The file is
 * compacted (deduped + rewritten) once it exceeds COMPACT_THRESHOLD_BYTES.
 *
 * Two kinds of lines share the same shape:
 *   - totals line   (modelId === TOTALS_MODEL_ID ''): promptCount,
 *     toolCallCount, toolBreakdown, errorCount, sessionCount are populated;
 *     token fields are 0. One per (date, projectDir).
 *   - per-model line (modelId === a real model id): inputTokens,
 *     outputTokens, cacheReadTokens, cacheCreationTokens are populated; the
 *     rest are 0/empty. Cost is NOT stored — it's computed at read time from
 *     MODEL_PRICING so a pricing fix retroactively corrects displayed cost.
 *   - finalized marker (projectDir === '', modelId === FINALIZED_MODEL_ID):
 *     one per date, carries only `finalizedAt`. A date only counts as closed
 *     (safe to trust the rollup with no live re-scan) once this exists.
 */

'use strict';

const path = require('node:path');
const os = require('node:os');
const config = require('../config.cjs');

const ROLLUP_PATH = path.join(os.homedir(), '.claude', 'session-manager', 'history-rollup.jsonl');
const COMPACT_THRESHOLD_BYTES = 5 * 1024 * 1024;

const TOTALS_MODEL_ID = '';
const FINALIZED_MODEL_ID = '__finalized__';
const FINALIZED_PROJECT_ID = '';
// Bumped when a bucket/finalized-marker line's shape changes in a way that
// requires re-deriving it from transcripts (v1 → v2 added `activeMinutes`).
// isDateFinalized() gates on this so old-shape finalized days get re-scanned
// by the existing finalizeClosedDays() budget/resume loop instead of a new
// migration path.
const ROLLUP_VERSION = 2;

function rollupKey(date, projectDir, modelId) {
  return `${date}|${projectDir}|${modelId}`;
}

/**
 * Merge JSONL lines into a Map<key, bucket>, last-write-wins per rollupKey.
 * Malformed lines are skipped rather than throwing, so one corrupt line
 * doesn't take down the whole rollup.
 */
function mergeRollupLines(lines) {
  const map = new Map();
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    if (!obj || typeof obj.date !== 'string') continue;
    const projectDir = typeof obj.projectDir === 'string' ? obj.projectDir : '';
    const modelId = typeof obj.modelId === 'string' ? obj.modelId : '';
    // v1 lines predate activeMinutes — default so every reader sees a number.
    if (typeof obj.activeMinutes !== 'number') obj.activeMinutes = 0;
    map.set(rollupKey(obj.date, projectDir, modelId), obj);
  }
  return map;
}

/**
 * Read all rollup lines and return the merged buckets whose `date` falls
 * within [fromDate, toDate] inclusive (both are localDate 'YYYY-MM-DD'
 * strings). Finalized-marker lines are included in the result — callers that
 * only want data lines should filter on modelId/projectDir.
 */
async function readRollup(fromDate, toDate) {
  const { exists, text } = await config.readText(ROLLUP_PATH);
  if (!exists || !text) return new Map();
  const merged = mergeRollupLines(text.split('\n'));
  const filtered = new Map();
  for (const [key, bucket] of merged) {
    if (bucket.date >= fromDate && bucket.date <= toDate) filtered.set(key, bucket);
  }
  return filtered;
}

/**
 * True if `date` (< today, by convention) has a finalized marker on disk
 * written at ROLLUP_VERSION or later. A marker written under an older schema
 * (no `v`, or v < ROLLUP_VERSION) is treated as NOT finalized so the existing
 * finalizeClosedDays() budget/resume pass re-scans and upgrades it in place —
 * no separate migration machinery needed.
 */
function isDateFinalized(mergedMap, date) {
  const bucket = mergedMap.get(rollupKey(date, FINALIZED_PROJECT_ID, FINALIZED_MODEL_ID));
  if (!bucket?.finalizedAt) return false;
  return (bucket.v ?? 1) >= ROLLUP_VERSION;
}

/**
 * Append bucket entries (append-only) to the rollup file, then compact
 * (dedupe + rewrite) if the file has grown past COMPACT_THRESHOLD_BYTES.
 * Uses config.cjs's validatePath/validateWrite for boundary safety and
 * writeTextAtomic (tmp + rename) for the compaction rewrite — never hand
 * rolls its own atomic-write scheme.
 */
async function appendRollupDays(entries) {
  if (!entries || entries.length === 0) return;

  const real = config.validatePath(ROLLUP_PATH);
  config.validateWrite(real);
  const fsp = require('node:fs/promises');
  await fsp.mkdir(path.dirname(real), { recursive: true });

  const lines = entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
  await fsp.appendFile(real, lines, 'utf8');

  let size = 0;
  try { size = (await fsp.stat(real)).size; } catch { /* just wrote it */ }
  if (size > COMPACT_THRESHOLD_BYTES) {
    await compact();
  }
}

/** Dedupe the rollup file down to its last-write-wins merged lines. */
async function compact() {
  const { exists, text } = await config.readText(ROLLUP_PATH);
  if (!exists || !text) return;
  const merged = mergeRollupLines(text.split('\n'));
  const rewritten = Array.from(merged.values()).map((b) => JSON.stringify(b)).join('\n') + '\n';
  await config.writeTextAtomic(ROLLUP_PATH, rewritten);
}

module.exports = {
  ROLLUP_PATH,
  COMPACT_THRESHOLD_BYTES,
  TOTALS_MODEL_ID,
  FINALIZED_MODEL_ID,
  FINALIZED_PROJECT_ID,
  ROLLUP_VERSION,
  rollupKey,
  mergeRollupLines,
  readRollup,
  isDateFinalized,
  appendRollupDays,
  compact,
};

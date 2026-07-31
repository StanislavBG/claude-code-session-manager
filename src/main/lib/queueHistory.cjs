'use strict';

// Moves terminal (completed/failed) scheduler jobs older than a retention
// window out of the hot queue.json jobs[] array into an append-only
// history.jsonl sidecar. Keeps queue.json small (mutation cost, broadcast
// payload size, pickNextBatch/reconcile scan cost all scale with jobs[]
// length) while preserving full history for the renderer's History view.
//
// Kept pure where fs isn't unavoidable: partitionJobs takes an injected
// `nowMs` and `opts` so it's testable without touching the real clock or
// disk. appendHistory/readHistory own the actual fs I/O.

const os = require('os');
const path = require('path');
const fsp = require('fs').promises;
const { HISTORY_RETENTION_MS } = require('./schedulerConfig.cjs');

const HISTORY_PATH = path.join(os.homedir(), '.claude', 'session-manager', 'scheduled-plans', 'history.jsonl');

function isFixPlanSlug(slug) {
  return /^\d+-fix-/.test(slug);
}

function jobKey(job) {
  return `${job?.slug ?? ''}|${job?.runId ?? ''}`;
}

/**
 * O(n) over `jobs`. Splits terminal jobs into `hot` (stays in queue.json)
 * and `toArchive` (moves to history.jsonl). A completed/failed job archives
 * only when ALL of:
 *   - status is 'completed' or 'failed'
 *   - finishedAt parses and is older than opts.retentionMs (default
 *     HISTORY_RETENTION_MS)
 *   - it is not the healTargetForFix() parent of a pending/running fix-plan
 *     job (NN-fix-<slug> relationships stay hot together so the fix-plan
 *     can still find and promote its original when it completes)
 */
function partitionJobs(jobs, nowMs, opts = {}) {
  const retentionMs = opts.retentionMs ?? HISTORY_RETENTION_MS;
  const list = Array.isArray(jobs) ? jobs : [];

  // Slugs of jobs that a still-pending/running fix-plan is going to try to
  // heal (see healTargetForFix in scheduler.cjs — same regex, kept in sync).
  const protectedSlugs = new Set();
  for (const j of list) {
    if (!j || !isFixPlanSlug(j.slug)) continue;
    if (j.status !== 'pending' && j.status !== 'running') continue;
    protectedSlugs.add(j.slug.replace(/^(\d+)-fix-/, '$1-'));
  }

  const hot = [];
  const toArchive = [];
  for (const j of list) {
    if (!j) continue;
    const finishedMs = j.finishedAt ? Date.parse(j.finishedAt) : NaN;
    const archivable =
      (j.status === 'completed' || j.status === 'failed') &&
      Number.isFinite(finishedMs) &&
      (nowMs - finishedMs) > retentionMs &&
      !protectedSlugs.has(j.slug);
    if (archivable) toArchive.push(j);
    else hot.push(j);
  }
  return { hot, toArchive };
}

/**
 * Append-only JSONL write, deduped by slug+runId against what's already on
 * disk. The dedupe exists for crash-safety: reconcile() appends BEFORE
 * dropping archived jobs from state.jobs, so a crash between those two steps
 * replays the same batch through partitionJobs on the next boot — dedupe
 * here is what stops that replay from double-writing history.
 */
async function appendHistory(entries) {
  const list = Array.isArray(entries) ? entries.filter(Boolean) : [];
  if (list.length === 0) return { appended: 0 };

  let existingText = '';
  try {
    existingText = await fsp.readFile(HISTORY_PATH, 'utf8');
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }

  const existingKeys = new Set();
  if (existingText) {
    for (const line of existingText.split('\n')) {
      if (!line.trim()) continue;
      try {
        existingKeys.add(jobKey(JSON.parse(line)));
      } catch {
        // corrupt/partial line — ignore for dedupe purposes
      }
    }
  }

  const fresh = list.filter((e) => !existingKeys.has(jobKey(e)));
  if (fresh.length === 0) return { appended: 0 };

  await fsp.mkdir(path.dirname(HISTORY_PATH), { recursive: true });
  const text = fresh.map((e) => JSON.stringify(e)).join('\n') + '\n';
  await fsp.appendFile(HISTORY_PATH, text, 'utf8');
  return { appended: fresh.length };
}

/**
 * Reads the newest `limit` (clamped [1,500], default 50) entries from
 * history.jsonl, newest-first, WITHOUT loading the whole file when it's
 * large — reads from the end in growing chunks until enough whole lines are
 * found (or the file start is reached).
 */
async function readHistory({ limit } = {}) {
  const cap = Math.max(1, Math.min(500, Number.isFinite(limit) ? Math.floor(limit) : 50));

  let fh;
  try {
    fh = await fsp.open(HISTORY_PATH, 'r');
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }

  try {
    const { size } = await fh.stat();
    if (size === 0) return [];

    let readSize = Math.min(65536, size);
    let lines = [];
    for (;;) {
      const start = size - readSize;
      const buf = Buffer.alloc(readSize);
      await fh.read(buf, 0, readSize, start);
      let text = buf.toString('utf8');
      if (start > 0) {
        // The chunk may begin mid-line; drop the (possibly partial) first
        // fragment rather than risk parsing a truncated record.
        const firstNl = text.indexOf('\n');
        text = firstNl === -1 ? '' : text.slice(firstNl + 1);
      }
      lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
      if (lines.length >= cap || readSize >= size) break;
      readSize = Math.min(readSize * 2, size);
    }

    const tail = lines.slice(-cap);
    const parsed = [];
    for (const line of tail) {
      try {
        parsed.push(JSON.parse(line));
      } catch {
        // corrupt/partial line — skip
      }
    }
    // File-order tail is oldest→newest; caller wants newest-first.
    return parsed.reverse();
  } finally {
    await fh.close();
  }
}

// mtime-gated cache, same convention as scheduler/prdParser.cjs's dirCache —
// repeated reconcile() calls between appends hit the cache instead of
// re-reading/re-parsing a JSONL file that only grows over time.
let historyCacheMtime = -1;
let historyCacheMap = null;

/**
 * Full-file scan of history.jsonl, returning slug -> { status, finishedAt }
 * for the most recently appended record of each slug. O(H) where H is the
 * line count of history.jsonl; cached by the file's mtime so a reconcile()
 * pass with no new archives since the last call is O(1).
 *
 * Exists so reconcile() can tell "this on-disk PRD's job row already left
 * jobs[] into history — do not resurrect it as a fresh pending job" apart
 * from "this is a genuinely brand-new PRD nobody has ever queued."
 */
async function historyTerminalBySlug() {
  let mtime;
  try {
    mtime = (await fsp.stat(HISTORY_PATH)).mtimeMs;
  } catch {
    mtime = -1;
  }
  if (mtime === historyCacheMtime && historyCacheMap) return historyCacheMap;

  const map = new Map();
  let text = '';
  try {
    text = await fsp.readFile(HISTORY_PATH, 'utf8');
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  if (text) {
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const j = JSON.parse(line);
        if (j?.slug) map.set(j.slug, { status: j.status, finishedAt: j.finishedAt, landedCommit: j.landedCommit ?? null });
      } catch {
        // corrupt/partial line — ignore
      }
    }
  }
  historyCacheMtime = mtime;
  historyCacheMap = map;
  return map;
}

module.exports = {
  HISTORY_PATH,
  partitionJobs,
  appendHistory,
  readHistory,
  historyTerminalBySlug,
};

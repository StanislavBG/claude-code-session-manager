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
const { projectHistoryPath, stateCwds } = require('./queueStore.cjs');

// Legacy global sidecar — READ-ONLY since 2026-07-31 (federated per-project
// history under <cwd>/session-manager-operations/scheduler/state/history.jsonl,
// resolved via queueStore.cjs). Old rows stay readable from here; new appends
// go to the owning project's shard (entries without a cwd still land here so
// nothing is ever dropped).
//
// Overridable via SM_HISTORY_PATH_OVERRIDE so queueHistory.test.cjs can point
// this at an isolated tmpdir path instead of racing a live Electron
// instance's scheduler.cjs, which writes this same machine-global file.
const HISTORY_PATH = process.env.SM_HISTORY_PATH_OVERRIDE
  || path.join(os.homedir(), '.claude', 'session-manager', 'scheduled-plans', 'history.jsonl');

/**
 * Every history file currently in play: each project's shard + the legacy
 * global. Under SM_HISTORY_PATH_OVERRIDE (queueHistory.test.cjs), skip the
 * federated per-project shards entirely — they're real files under whatever
 * projects exist on this machine's ~/.claude/projects, so including them
 * would leak real production history rows into an otherwise-isolated test.
 */
function historyPaths() {
  if (process.env.SM_HISTORY_PATH_OVERRIDE) return [HISTORY_PATH];
  const paths = [];
  for (const cwd of stateCwds()) {
    try { paths.push(projectHistoryPath(cwd)); } catch { /* unusable cwd */ }
  }
  paths.push(HISTORY_PATH);
  return paths;
}

function historyPathFor(entry) {
  if (entry && entry.cwd) {
    try { return projectHistoryPath(entry.cwd); } catch { /* fall through */ }
  }
  return HISTORY_PATH;
}

function isFixPlanSlug(slug) {
  return /^\d+-fix-/.test(slug);
}

function jobKey(job) {
  return `${job?.slug ?? ''}|${job?.runId ?? ''}`;
}

/**
 * O(n) over `jobs`. Splits terminal jobs into `hot` (stays in queue.json)
 * and `toArchive` (moves to history.jsonl). A completed/failed/skipped job
 * archives only when ALL of:
 *   - status is 'completed', 'failed', or 'skipped' (skipped: a job whose
 *     PRD source vanished before dispatch — never ran, but still terminal,
 *     and must age out of the hot queue the same as any other finished row)
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
      (j.status === 'completed' || j.status === 'failed' || j.status === 'skipped') &&
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

  // Federated: each entry appends to its own project's shard (fallback: the
  // legacy global file for cwd-less rows). Dedupe stays per target file.
  const byPath = new Map();
  for (const e of list) {
    const target = historyPathFor(e);
    if (!byPath.has(target)) byPath.set(target, []);
    byPath.get(target).push(e);
  }

  let appended = 0;
  for (const [target, group] of byPath) {
    let existingText = '';
    try {
      existingText = await fsp.readFile(target, 'utf8');
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

    const fresh = group.filter((e) => !existingKeys.has(jobKey(e)));
    if (fresh.length === 0) continue;

    await fsp.mkdir(path.dirname(target), { recursive: true });
    const text = fresh.map((e) => JSON.stringify(e)).join('\n') + '\n';
    await fsp.appendFile(target, text, 'utf8');
    appended += fresh.length;
  }
  return { appended };
}

/**
 * Reads the newest `limit` (clamped [1,500], default 50) entries from
 * history.jsonl, newest-first, WITHOUT loading the whole file when it's
 * large — reads from the end in growing chunks until enough whole lines are
 * found (or the file start is reached).
 */
async function readHistory({ limit } = {}) {
  const cap = Math.max(1, Math.min(500, Number.isFinite(limit) ? Math.floor(limit) : 50));
  // Federated: newest `cap` from EACH file, merged newest-first by finishedAt
  // (fallback startedAt), then capped. Per-file tail reads keep this cheap.
  const chunks = await Promise.all(historyPaths().map((p2) => readHistoryFile(p2, cap)));
  const ts = (e) => Date.parse(e?.finishedAt ?? e?.startedAt ?? '') || 0;
  // Each chunk is already newest-first; keep that order as the tiebreak so
  // timestamp-less rows don't get shuffled by the cross-file sort.
  const tagged = chunks.flatMap((chunk) => chunk.map((e, idx) => ({ e, ts: ts(e), idx })));
  tagged.sort((a, b) => (b.ts - a.ts) || (a.idx - b.idx));
  return tagged.slice(0, cap).map((t) => t.e);
}

/** Tail-read one history file: newest `cap` parsed rows, newest-first. */
async function readHistoryFile(target, cap) {
  let fh;
  try {
    fh = await fsp.open(target, 'r');
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
let historyCacheKey = null;
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
  const paths = historyPaths();
  const mtimes = await Promise.all(paths.map(async (p2) => {
    try { return (await fsp.stat(p2)).mtimeMs; } catch { return -1; }
  }));
  const cacheKey = paths.map((p2, i) => `${p2}:${mtimes[i]}`).join('|');
  if (cacheKey === historyCacheKey && historyCacheMap) return historyCacheMap;

  const map = new Map();
  for (const p2 of paths) {
    let text = '';
    try {
      text = await fsp.readFile(p2, 'utf8');
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    if (!text) continue;
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
  historyCacheKey = cacheKey;
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

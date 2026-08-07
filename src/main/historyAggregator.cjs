'use strict';

const { ipcMain } = require('electron');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { schemas } = require('./ipcSchemas.cjs');
const historyRollup = require('./lib/historyRollup.cjs');

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const PARSE_BUDGET_MS = 2_000;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
// Cache entries are small scalar aggregates (token counts, per-model buckets, a
// tool-name histogram) — NOT raw transcript content — so a much larger cap costs
// little memory. 50k is safely above the observed real-workspace file count
// (~26,604 .jsonl files on the dev machine), so repeat scans over the same date
// range hit cache instead of self-evicting mid-scan and spuriously truncating.
const CACHE_MAX = 50_000;

// Dollars per million tokens (input / output / cache-read). Cache-read
// tokens are priced far below input because they're served from
// Anthropic's prompt cache, not re-processed — this is what makes the
// cache-savings figure in the dashboard real money, not a vanity stat.
const MODEL_PRICING = {
  opus:   { i: 15,  o: 75, c: 1.5 },
  sonnet: { i: 3,   o: 15, c: 0.3 },
  haiku:  { i: 0.8, o: 4,  c: 0.08 },
};
const DEFAULT_PRICING_KEY = 'sonnet'; // fallback for unrecognized model ids

/**
 * Resolve a raw model id (e.g. "claude-opus-4-8-20260115") to a pricing
 * bucket key. Model ids aren't stable enough to match exactly, so this is a
 * case-insensitive substring check. Unrecognized ids fall back to
 * DEFAULT_PRICING_KEY and are flagged so callers can annotate them as
 * estimated rather than exact.
 */
function resolvePricingKey(modelId) {
  const id = String(modelId ?? '').toLowerCase();
  if (id.includes('opus')) return { key: 'opus', estimated: false };
  if (id.includes('sonnet')) return { key: 'sonnet', estimated: false };
  if (id.includes('haiku')) return { key: 'haiku', estimated: false };
  return { key: DEFAULT_PRICING_KEY, estimated: true };
}

// ── LRU cache ─────────────────────────────────────────────────────────────────
// Backed by an insertion-order Map: delete+re-insert on access = O(1) LRU.
class LRUCache {
  constructor(max) {
    this._max = max;
    this._m = new Map();
  }
  get(k) {
    if (!this._m.has(k)) return undefined;
    const v = this._m.get(k);
    this._m.delete(k);
    this._m.set(k, v);
    return v;
  }
  set(k, v) {
    this._m.delete(k);
    this._m.set(k, v);
    if (this._m.size > this._max) this._m.delete(this._m.keys().next().value);
  }
}

/**
 * Cache for parseJSONL results.
 * Entry shape: { mtimeMs: number, size: number, readOffset: number, inode: number, result: AggrResult }
 * `size` mirrors stat.size (used for exact-hit comparison).
 * `readOffset` is the byte position of the end of the last complete line
 * (≤ size) — the start position for the next tail-read so we never start
 * mid-line.
 */
const aggrCache = new LRUCache(CACHE_MAX);

// ── bounded concurrency helper ───────────────────────────────────────────────

/**
 * Run async fn(item) over items with at most `limit` in flight at once, via a
 * pull-based worker pool (not chunked batches, so a slow item never stalls
 * the rest of a batch). Node's fs promise APIs are backed by libuv's
 * fixed-size threadpool (UV_THREADPOOL_SIZE, default 4) — firing every call
 * at once via a single Promise.all still queues behind that pool one way or
 * another, so bounding `limit` mainly avoids building thousands of pending
 * promises/Buffers at once for a 25k+-file walk. Results are returned in
 * input order; a thrown fn(item) rejects the whole call (callers here always
 * catch inside fn instead).
 */
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker);
  await Promise.all(workers);
  return results;
}

// ── date helpers ──────────────────────────────────────────────────────────────

function decodeCwd(encoded) {
  return '/' + encoded.replace(/-+/g, '/');
}

// All date strings in this module are LOCAL-TZ YYYY-MM-DD. A previous version
// used UTC (toISOString().slice(0,10)) which silently shifted late-evening
// sessions a day forward for Pacific-time users, then the >= effectiveTo
// filter dropped them entirely. en-CA locale yields ISO-format dates in the
// JS environment's TZ. Parse with 'T12:00:00' (local noon) so DST boundaries
// don't shift the date by a day.
function localDate(d) {
  return d.toLocaleDateString('en-CA');
}

function subtractDays(dateStr, days) {
  const d = new Date(dateStr + 'T12:00:00');
  d.setDate(d.getDate() - days);
  return localDate(d);
}

// ── low-level I/O ─────────────────────────────────────────────────────────────

/** Read bytes [from, to) from filePath and return as a UTF-8 string. */
async function readSlice(filePath, from, to) {
  const len = to - from;
  if (len <= 0) return '';
  const fh = await fsp.open(filePath, 'r');
  try {
    const buf = Buffer.alloc(len);
    const { bytesRead } = await fh.read(buf, 0, len, from);
    return buf.subarray(0, bytesRead).toString('utf8');
  } finally {
    await fh.close();
  }
}

// ── line scanners ─────────────────────────────────────────────────────────────

/**
 * Scan JSONL lines into an aggregate accumulator (mutates acc).
 * Returns { firstTs, lastTs } — firstTs is only captured when
 * captureFirst=true (else null); lastTs is the most recent event timestamp
 * seen in this batch of lines (file order, so simply "last one wins").
 */
function scanAggrLines(lines, acc, captureFirst) {
  let firstTs = null;
  let lastTs = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }

    const ts = obj.ts ?? obj.timestamp;
    if (ts) {
      if (captureFirst && firstTs === null) firstTs = ts;
      lastTs = ts;
    }

    const role = obj.role ?? obj.message?.role;
    if (role === 'user') acc.promptCount++;

    const usage = obj.usage ?? obj.message?.usage;
    if (usage && typeof usage === 'object') {
      // Claude Code JSONLs use snake_case (matching the Anthropic API). The
      // previous camelCase-only check meant every token count read as 0.
      const inT = usage.input_tokens ?? usage.inputTokens;
      const outT = usage.output_tokens ?? usage.outputTokens;
      const cacheR = usage.cache_read_input_tokens ?? usage.cacheReadInputTokens;
      const cacheC = usage.cache_creation_input_tokens ?? usage.cacheCreationInputTokens;
      if (typeof inT === 'number') acc.inputTokens += inT;
      if (typeof outT === 'number') acc.outputTokens += outT;
      if (typeof cacheR === 'number') acc.cacheReadTokens += cacheR;
      if (typeof cacheC === 'number') acc.cacheCreationTokens += cacheC;

      // Only assistant usage lines carry model+usage together in practice;
      // read defensively rather than assuming every usage line has a model.
      const modelId = obj.message?.model;
      if (typeof modelId === 'string' && modelId) {
        const bucket = acc.byModel[modelId] ?? (acc.byModel[modelId] = {
          inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
        });
        if (typeof inT === 'number') bucket.inputTokens += inT;
        if (typeof outT === 'number') bucket.outputTokens += outT;
        if (typeof cacheR === 'number') bucket.cacheReadTokens += cacheR;
        if (typeof cacheC === 'number') bucket.cacheCreationTokens += cacheC;
      }
    }

    const content = obj.message?.content ?? obj.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block?.type === 'tool_use' && typeof block.name === 'string') {
          acc.toolCallCount++;
          acc.toolBreakdown[block.name] = (acc.toolBreakdown[block.name] ?? 0) + 1;
        }
      }
    }

    if (
      (obj.type === 'tool_result' && obj.is_error === true) ||
      obj.message?.stop_reason === 'error' ||
      obj.stop_reason === 'error'
    ) {
      acc.errorCount++;
    }
  }
  return { firstTs, lastTs };
}

/**
 * Per-file activeMinutes = elapsed wall-clock time between the file's first
 * and last event, clamped to [0, 24h] so a corrupt/out-of-order timestamp
 * pair can't blow up a day's total. O(1).
 */
function computeActiveMinutes(firstTs, lastTs) {
  if (!firstTs || !lastTs) return 0;
  const a = Date.parse(firstTs);
  const b = Date.parse(lastTs);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  const minutes = (b - a) / 60000;
  return Math.max(0, Math.min(24 * 60, minutes));
}

// ── cached file parsers ───────────────────────────────────────────────────────

/**
 * Parse a JSONL transcript for history aggregation.
 * Returns { result, cacheHit } where cacheHit=true means no I/O was performed.
 *
 * Cache strategy:
 *   same (mtimeMs, size)  → exact hit, no I/O
 *   size grown, same path → tail-parse new bytes from cached.size, merge
 *   otherwise             → full reparse (file replaced or truncated)
 */
async function parseJSONL(filePath, stat) {
  const emptyAcc = () => ({
    promptCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    toolCallCount: 0,
    toolBreakdown: {},
    byModel: {},
    errorCount: 0,
    sessionDate: null,
    firstEventTs: null,
    lastEventTs: null,
    skipped: false,
  });

  if (stat.size > MAX_FILE_BYTES) {
    return { result: { ...emptyAcc(), skipped: true }, cacheHit: false };
  }

  const cached = aggrCache.get(filePath);
  if (cached) {
    // cached.result.lastEventTs !== undefined guards against pre-activeMinutes
    // cache entries (shape: no firstEventTs/lastEventTs fields) — those must
    // fall through to a full reparse so activeMinutes gets backfilled, rather
    // than being served as a stale exact hit.
    if (cached.size === stat.size && cached.mtimeMs === stat.mtimeMs && cached.result.lastEventTs !== undefined) {
      return { result: cached.result, cacheHit: true };
    }

    if (stat.size > cached.size) {
      // Inode change means the file was replaced (e.g. claude --resume
      // compaction). Don't tail-parse a stale byte range into new content.
      if (cached.inode !== undefined && cached.inode !== stat.ino) {
        // fall through to full parse
      } else {
        // Append-only tail parse: read only the new bytes. Use cached.readOffset
        // (the end of the last complete line) as the start so we never begin
        // mid-line. Falls back to cached.size for pre-fix cache entries.
        try {
          const readFrom = cached.readOffset ?? cached.size;
          const tail = await readSlice(filePath, readFrom, stat.size);
          const delta = emptyAcc();
          const { lastTs: deltaLastTs } = scanAggrLines(tail.split('\n'), delta, false);
          const prev = cached.result;
          const merged = {
            promptCount: prev.promptCount + delta.promptCount,
            inputTokens: prev.inputTokens + delta.inputTokens,
            outputTokens: prev.outputTokens + delta.outputTokens,
            cacheReadTokens: prev.cacheReadTokens + delta.cacheReadTokens,
            cacheCreationTokens: prev.cacheCreationTokens + delta.cacheCreationTokens,
            toolCallCount: prev.toolCallCount + delta.toolCallCount,
            toolBreakdown: { ...prev.toolBreakdown },
            byModel: {},
            errorCount: prev.errorCount + delta.errorCount,
            sessionDate: prev.sessionDate, // firstTs doesn't change on appends
            firstEventTs: prev.firstEventTs ?? null,
            lastEventTs: deltaLastTs ?? (prev.lastEventTs ?? null),
            skipped: false,
          };
          for (const [k, v] of Object.entries(delta.toolBreakdown)) {
            merged.toolBreakdown[k] = (merged.toolBreakdown[k] ?? 0) + v;
          }
          for (const [modelId, srcBucket] of Object.entries(prev.byModel ?? {})) {
            merged.byModel[modelId] = { ...srcBucket };
          }
          for (const [modelId, deltaBucket] of Object.entries(delta.byModel)) {
            const b = merged.byModel[modelId] ?? (merged.byModel[modelId] = {
              inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
            });
            b.inputTokens += deltaBucket.inputTokens;
            b.outputTokens += deltaBucket.outputTokens;
            b.cacheReadTokens += deltaBucket.cacheReadTokens;
            b.cacheCreationTokens += deltaBucket.cacheCreationTokens;
          }
          // readOffset advances to the last complete newline so the next tail
          // always starts at a line boundary. size stays at stat.size so the
          // exact-hit check works correctly on the next call.
          const lastNl = tail.lastIndexOf('\n');
          const readOffset = lastNl >= 0 ? readFrom + lastNl + 1 : readFrom;
          aggrCache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, readOffset, inode: stat.ino, result: merged });
          return { result: merged, cacheHit: false };
        } catch {
          // fall through to full parse
        }
      }
    }
    // size shrank, inode changed, or mtime changed → file was replaced; full reparse below
  }

  // Full parse
  let text;
  try { text = await fsp.readFile(filePath, 'utf8'); } catch {
    return { result: emptyAcc(), cacheHit: false };
  }

  const acc = emptyAcc();
  const { firstTs, lastTs } = scanAggrLines(text.split('\n'), acc, true);
  acc.firstEventTs = firstTs;
  acc.lastEventTs = lastTs;

  try {
    acc.sessionDate = firstTs
      ? localDate(new Date(firstTs))
      : localDate(new Date(stat.mtimeMs));
  } catch {
    acc.sessionDate = localDate(new Date(stat.mtimeMs));
  }

  const lastNlFull = text.lastIndexOf('\n');
  const readOffsetFull = lastNlFull >= 0 ? lastNlFull + 1 : 0;
  aggrCache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, readOffset: readOffsetFull, inode: stat.ino, result: acc });
  return { result: acc, cacheHit: false };
}

// ── rollup bridge ─────────────────────────────────────────────────────────────
// Converts between the in-memory per-(date,project) accumulator bucket shape
// used by aggregate()/finalizeClosedDays() and the on-disk rollup line shape
// (one line per (date, projectDir, modelId) — see historyRollup.cjs header).

function emptyBucket(sessionDate, encodedCwd) {
  return {
    date: sessionDate,
    projectCwd: decodeCwd(encodedCwd),
    encodedCwd,
    promptCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    toolCallCount: 0,
    toolBreakdown: {},
    byModel: {},
    sessionCount: 0,
    errorCount: 0,
    activeMinutes: 0,
  };
}

/** Fold one parsed-file result into an accumulator bucket (mutates b). */
function foldParsedIntoBucket(b, parsed) {
  b.promptCount += parsed.promptCount;
  b.inputTokens += parsed.inputTokens;
  b.outputTokens += parsed.outputTokens;
  b.cacheReadTokens += parsed.cacheReadTokens;
  b.cacheCreationTokens += parsed.cacheCreationTokens;
  b.toolCallCount += parsed.toolCallCount;
  for (const [tool, cnt] of Object.entries(parsed.toolBreakdown)) {
    b.toolBreakdown[tool] = (b.toolBreakdown[tool] ?? 0) + cnt;
  }
  for (const [modelId, srcBucket] of Object.entries(parsed.byModel ?? {})) {
    const dst = b.byModel[modelId] ?? (b.byModel[modelId] = {
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
    });
    dst.inputTokens += srcBucket.inputTokens;
    dst.outputTokens += srcBucket.outputTokens;
    dst.cacheReadTokens += srcBucket.cacheReadTokens;
    dst.cacheCreationTokens += srcBucket.cacheCreationTokens;
  }
  b.sessionCount++;
  b.errorCount += parsed.errorCount;
  b.activeMinutes += computeActiveMinutes(parsed.firstEventTs, parsed.lastEventTs);
}

/** One accumulator bucket → its rollup lines (one totals line + one per model). */
function bucketToRollupLines(b) {
  const lines = [{
    date: b.date,
    projectDir: b.encodedCwd,
    modelId: historyRollup.TOTALS_MODEL_ID,
    promptCount: b.promptCount,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    toolCallCount: b.toolCallCount,
    toolBreakdown: b.toolBreakdown,
    errorCount: b.errorCount,
    sessionCount: b.sessionCount,
    activeMinutes: b.activeMinutes,
    v: historyRollup.ROLLUP_VERSION,
  }];
  for (const [modelId, mb] of Object.entries(b.byModel)) {
    lines.push({
      date: b.date,
      projectDir: b.encodedCwd,
      modelId,
      promptCount: 0,
      inputTokens: mb.inputTokens,
      outputTokens: mb.outputTokens,
      cacheReadTokens: mb.cacheReadTokens,
      cacheCreationTokens: mb.cacheCreationTokens,
      toolCallCount: 0,
      toolBreakdown: {},
      errorCount: 0,
      sessionCount: 0,
      activeMinutes: 0,
      v: historyRollup.ROLLUP_VERSION,
    });
  }
  return lines;
}

function finalizedMarkerLine(date) {
  return {
    date,
    projectDir: historyRollup.FINALIZED_PROJECT_ID,
    modelId: historyRollup.FINALIZED_MODEL_ID,
    finalizedAt: Date.now(),
    v: historyRollup.ROLLUP_VERSION,
  };
}

/**
 * Reconstruct accumulator-shaped rows from rollup lines, restricted to dates
 * in `finalizedDates` — only finalized days are trusted as complete enough
 * to serve without a live re-scan.
 */
function rollupMapToRows(map, finalizedDates) {
  const grouped = new Map();
  for (const bucket of map.values()) {
    if (bucket.projectDir === historyRollup.FINALIZED_PROJECT_ID && bucket.modelId === historyRollup.FINALIZED_MODEL_ID) continue;
    if (!finalizedDates.has(bucket.date)) continue;
    const groupKey = `${bucket.date}|${bucket.projectDir}`;
    let row = grouped.get(groupKey);
    if (!row) {
      row = emptyBucket(bucket.date, bucket.projectDir);
      grouped.set(groupKey, row);
    }
    if (bucket.modelId === historyRollup.TOTALS_MODEL_ID) {
      row.promptCount += bucket.promptCount || 0;
      row.toolCallCount += bucket.toolCallCount || 0;
      row.errorCount += bucket.errorCount || 0;
      row.sessionCount += bucket.sessionCount || 0;
      row.activeMinutes += bucket.activeMinutes || 0;
      for (const [tool, cnt] of Object.entries(bucket.toolBreakdown || {})) {
        row.toolBreakdown[tool] = (row.toolBreakdown[tool] ?? 0) + cnt;
      }
    } else {
      const dst = row.byModel[bucket.modelId] ?? (row.byModel[bucket.modelId] = {
        inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
      });
      dst.inputTokens += bucket.inputTokens || 0;
      dst.outputTokens += bucket.outputTokens || 0;
      dst.cacheReadTokens += bucket.cacheReadTokens || 0;
      dst.cacheCreationTokens += bucket.cacheCreationTokens || 0;
      row.inputTokens += bucket.inputTokens || 0;
      row.outputTokens += bucket.outputTokens || 0;
      row.cacheReadTokens += bucket.cacheReadTokens || 0;
      row.cacheCreationTokens += bucket.cacheCreationTokens || 0;
    }
  }
  return grouped;
}

/**
 * Boot-time (and self-healing) finalize pass: walks ALL transcripts, buckets
 * every day strictly before today, and persists them to the rollup with a
 * `finalizedAt` stamp. Once a day is finalized, aggregate() trusts the rollup
 * for it — never re-touching the underlying .jsonl files — so it survives
 * both process restarts and transcript deletion/retention cleanup.
 *
 * O(total transcript bytes) — bounded by the shared parseJSONL LRU cache.
 *
 * opts.budgetMs (optional): caps the wall-clock time spent walking project
 * directories. Project directories are visited in a stable sorted order and
 * are each read to completion once started (never split mid-directory) so a
 * date's bucket is only ever built from directories that were fully walked.
 * If the budget runs out before every project directory has been visited,
 * NO date is stamped `finalizedAt` this call (a date isn't safe to trust as
 * complete until every directory has contributed) — the caller can invoke
 * finalizeClosedDays() again later and it will redo the (idempotent) walk.
 * Partial results are still persisted as plain (non-finalized) rollup lines
 * so aggregate() benefits from them immediately.
 *
 * opts.dryRun (optional): computes what would be finalized without writing
 * anything to the rollup file.
 */
async function finalizeClosedDays({ budgetMs, dryRun = false } = {}) {
  const deadline = typeof budgetMs === 'number' ? Date.now() + budgetMs : null;
  const today = localDate(new Date());

  let projectDirs;
  try {
    projectDirs = await fsp.readdir(PROJECTS_DIR, { withFileTypes: true });
  } catch {
    return { finalizedDates: [], partial: false };
  }

  projectDirs = projectDirs
    .filter((e) => e.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name));

  const buckets = new Map();
  let partial = false;

  for (const projEntry of projectDirs) {
    if (deadline !== null && Date.now() >= deadline) {
      partial = true;
      break;
    }

    const encodedCwd = projEntry.name;
    const projectDir = path.join(PROJECTS_DIR, encodedCwd);

    let files;
    try { files = await fsp.readdir(projectDir, { withFileTypes: true }); } catch { continue; }

    for (const fileEntry of files) {
      if (!fileEntry.name.endsWith('.jsonl')) continue;
      const filePath = path.join(projectDir, fileEntry.name);

      let stat;
      try { stat = await fsp.stat(filePath); } catch { continue; }

      const { result: parsed } = await parseJSONL(filePath, stat);
      if (parsed.skipped) continue;

      const { sessionDate } = parsed;
      if (!sessionDate || sessionDate >= today) continue;

      const key = `${sessionDate}|${encodedCwd}`;
      if (!buckets.has(key)) buckets.set(key, emptyBucket(sessionDate, encodedCwd));
      foldParsedIntoBucket(buckets.get(key), parsed);
    }
  }

  const dates = new Set();
  const entries = [];
  for (const b of buckets.values()) {
    dates.add(b.date);
    entries.push(...bucketToRollupLines(b));
  }
  // Only stamp dates as finalized (safe to trust with no live re-scan) when
  // the walk visited every project directory within budget — a partial walk
  // may be missing contributions from directories not yet visited.
  if (!partial) {
    for (const date of dates) entries.push(finalizedMarkerLine(date));
  }

  if (!dryRun) {
    await historyRollup.appendRollupDays(entries);
  }
  return { finalizedDates: partial ? [] : Array.from(dates), partial };
}

// ── intraday fast-walk state ──────────────────────────────────────────────────
//
// Two persistent (in-memory only, process-lifetime) caches make repeat ticks
// cheap:
//
// 1. `intradayDirRegistry` — encodedCwd -> { mtimeMs, fileNames }. Verified
//    empirically on this machine (ext4): appending to an EXISTING file does
//    NOT change its parent directory's mtime — only creating/removing/
//    renaming a directory entry does. So a directory's mtime is a safe signal
//    for "no file was added or removed here since last tick", letting us skip
//    re-`readdir()`ing it (2,044 directories on the dev machine — this alone
//    doesn't bound the file-level stat count).
//
// 2. `intradayNotToday` — a permanent Set<filePath> of files CONFIRMED to
//    belong to a day other than today, so they can never contribute to
//    today's bucket again. This is the lever that makes the walk actually
//    proportional to files modified today, and it's safe only because of an
//    existing, unrelated invariant this PRD does not change: a transcript's
//    `sessionDate` is fixed by its FIRST message's timestamp and never
//    updates on later appends (see parseJSONL's cache — `merged.sessionDate
//    = prev.sessionDate`), so `aggregate()`/`refreshIntradayToday()` already
//    attribute 100% of a file's activity to its original day no matter how
//    many later days it's appended on. A file whose mtime is confirmed to
//    predate today can have no content newer than that mtime, so its
//    sessionDate can't be today either — that classification is exclusion
//    forever, not just for the rest of today. Combined with #1 (a file
//    relevant to today must have been CREATED today, which does bump its
//    directory's mtime and is therefore always discovered), the walk over
//    time shrinks to: files still active today (small, must keep re-stat-ing
//    to catch growth) + any brand-new file since the last tick. Everything
//    else is skipped without even a stat(2) call. Remaining stat/readdir
//    calls run with bounded concurrency instead of one sequential await per
//    call, since that was the other half of the sequential-walk cost
//    (29,625 stats + 2,044 readdirs, 589ms measured on this machine).
let intradayDirRegistry = new Map(); // encodedCwd -> { mtimeMs, fileNames: string[] }
let intradayNotToday = new Set(); // filePath -> confirmed not-today, forever

const INTRADAY_STAT_CONCURRENCY = 64;
const INTRADAY_STRATEGY = 'directory-mtime skips re-readdir of unchanged dirs (new-file detection); ' +
  'a file confirmed to belong to a past day (mtime, then sessionDate) is excluded from every future tick ' +
  '(sessionDate is pinned to a transcript\'s first message and never changes on later appends); ' +
  `remaining stat/readdir calls run with bounded concurrency (${INTRADAY_STAT_CONCURRENCY} in flight)`;

/** Test-only: clears the in-memory directory/exclusion registries between fixtures. */
function resetIntradayRegistryForTests() {
  intradayDirRegistry = new Map();
  intradayNotToday = new Set();
}

/**
 * Pure walk-and-parse step (no rollup write) — split out from
 * refreshIntradayToday() so it can be benchmarked read-only against the real
 * ~/.claude/projects (see scripts/bench-intraday-walk.cjs) without touching
 * the rollup file on disk.
 */
async function computeIntradayBuckets() {
  const today = localDate(new Date());

  let projectDirs;
  try {
    projectDirs = await fsp.readdir(PROJECTS_DIR, { withFileTypes: true });
  } catch {
    return { today, buckets: new Map() };
  }

  const dirEntries = projectDirs.filter((e) => e.isDirectory());

  // Directory count (thousands) is far smaller than file count (tens of
  // thousands), so stat-ing every directory concurrently is cheap and tells
  // us which ones had an entry added/removed since we last looked.
  const dirStats = await mapWithConcurrency(dirEntries, INTRADAY_STAT_CONCURRENCY, async (entry) => {
    const dirPath = path.join(PROJECTS_DIR, entry.name);
    try {
      const stat = await fsp.stat(dirPath);
      return { encodedCwd: entry.name, dirPath, mtimeMs: stat.mtimeMs };
    } catch {
      return null;
    }
  });

  // Resolve the jsonl file list per directory — reuse the cached list (no
  // readdir syscall) when the directory's mtime hasn't moved since the last
  // tick; re-enumerate only directories that are new or changed. Files
  // already known to be irrelevant to any future "today" are dropped here so
  // they never reach the stat step below.
  const fileCandidates = []; // { filePath, encodedCwd }
  await mapWithConcurrency(dirStats.filter(Boolean), INTRADAY_STAT_CONCURRENCY, async (d) => {
    const cached = intradayDirRegistry.get(d.encodedCwd);
    let fileNames;
    if (cached && cached.mtimeMs === d.mtimeMs) {
      fileNames = cached.fileNames;
    } else {
      let files;
      try { files = await fsp.readdir(d.dirPath, { withFileTypes: true }); } catch { files = []; }
      fileNames = files.filter((f) => f.isFile() && f.name.endsWith('.jsonl')).map((f) => f.name);
      intradayDirRegistry.set(d.encodedCwd, { mtimeMs: d.mtimeMs, fileNames });
    }
    for (const name of fileNames) {
      const filePath = path.join(d.dirPath, name);
      if (intradayNotToday.has(filePath)) continue;
      fileCandidates.push({ filePath, encodedCwd: d.encodedCwd });
    }
  });

  // Known caveat: parseJSONL separately detects a same-path file replacement
  // (inode change — e.g. a `claude --resume` compaction rewriting a
  // transcript from scratch) and re-parses it in full. If that happens to a
  // path already in intradayNotToday, this walk will never look at it again
  // to notice its (hypothetical) new sessionDate, since exclusion here skips
  // the stat entirely. This is safe in practice: the History dashboard's
  // actual reads (aggregate()) don't consult this cache at all and always
  // re-walk live for "today", so the only blast radius is a stale PROVISIONAL
  // rollup line for the affected project until the next app restart resets
  // this cache — never a wrong number on the dashboard itself.
  const buckets = new Map();
  await mapWithConcurrency(fileCandidates, INTRADAY_STAT_CONCURRENCY, async ({ filePath, encodedCwd }) => {
    let stat;
    try { stat = await fsp.stat(filePath); } catch { return; }

    // A file whose mtime is before today can't have any content from today —
    // and per the sessionDate-pinning invariant above, can never gain any —
    // so it's excluded forever, with no parse ever needed.
    const mtimeDate = localDate(new Date(stat.mtimeMs));
    if (mtimeDate < today) {
      intradayNotToday.add(filePath);
      return;
    }

    const { result: parsed } = await parseJSONL(filePath, stat);
    if (parsed.skipped) return;
    if (parsed.sessionDate !== today) {
      intradayNotToday.add(filePath);
      return;
    }

    const key = `${today}|${encodedCwd}`;
    if (!buckets.has(key)) buckets.set(key, emptyBucket(today, encodedCwd));
    foldParsedIntoBucket(buckets.get(key), parsed);
  });

  return { today, buckets };
}

/**
 * Refresh TODAY's rollup buckets from a live (LRU-warm, cheap) parse of every
 * transcript touched today, and upsert them as provisional lines (v2, no
 * finalizedAt) so the History dashboard's "today" row stays current without
 * the renderer ever triggering a transcript scan itself. Meant to be called
 * on a timer (HISTORY_INTRADAY_REFRESH_MS) plus once at app start.
 *
 * readRollup/appendRollupDays last-write-wins per (date, projectDir, modelId)
 * key, so re-running this simply replaces today's previous provisional lines
 * with fresher ones — no separate "clear provisional" step needed.
 *
 * See INTRADAY_STRATEGY / intradayDirRegistry's comment above for why this is
 * both faster and no less correct than the old unconditional full walk.
 */
async function refreshIntradayToday() {
  const { today, buckets } = await computeIntradayBuckets();

  const entries = [];
  for (const b of buckets.values()) entries.push(...bucketToRollupLines(b));
  if (entries.length) await historyRollup.appendRollupDays(entries);

  return { date: today, projectsUpdated: buckets.size, strategy: INTRADAY_STRATEGY };
}

// ── aggregate ─────────────────────────────────────────────────────────────────

async function aggregate(req) {
  const t0 = Date.now();
  const today = localDate(new Date());
  let effectiveTo = req?.toDate ? req.toDate : today;
  if (effectiveTo > today) effectiveTo = today;
  const effectiveFrom = req?.fromDate ? req.fromDate : subtractDays(today, 30);

  // Closed (pre-today) days: consult the durable rollup first. A day only
  // short-circuits the live file walk once it's finalized — see
  // finalizeClosedDays(). Unfinalized past days still get live-parsed below
  // (and folded back into the rollup as a self-healing backfill) so results
  // stay correct even before the boot finalize pass has run.
  const yesterday = subtractDays(today, 1);
  const rollupToDate = effectiveTo < today ? effectiveTo : yesterday;
  let rollupMap = new Map();
  if (effectiveFrom <= rollupToDate) {
    rollupMap = await historyRollup.readRollup(effectiveFrom, rollupToDate);
  }
  const finalizedDates = new Set();
  for (const bucket of rollupMap.values()) {
    if (
      bucket.projectDir === historyRollup.FINALIZED_PROJECT_ID &&
      bucket.modelId === historyRollup.FINALIZED_MODEL_ID &&
      bucket.finalizedAt
    ) {
      finalizedDates.add(bucket.date);
    }
  }

  const buckets = new Map();
  let truncated = false;
  let skippedLargeFiles = 0;
  let skippedBudgetFiles = 0;
  let parseBudgetSpentMs = 0;

  let projectDirs;
  try {
    projectDirs = await fsp.readdir(PROJECTS_DIR, { withFileTypes: true });
  } catch {
    return { rows: [], partial: false, truncated: false, scannedMs: Date.now() - t0, cacheSavingsUsd: 0, rollupDays: 0, liveDays: 0 };
  }

  outer:
  for (const projEntry of projectDirs) {
    if (!projEntry.isDirectory()) continue;
    const encodedCwd = projEntry.name;
    const projectDir = path.join(PROJECTS_DIR, encodedCwd);

    let files;
    try {
      files = await fsp.readdir(projectDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const fileEntry of files) {
      if (!fileEntry.name.endsWith('.jsonl')) continue;
      const filePath = path.join(projectDir, fileEntry.name);

      let stat;
      try { stat = await fsp.stat(filePath); } catch { continue; }

      // Fast skip: a file last modified on an already-finalized past day is
      // trusted from the rollup and never touched. A file whose true content
      // belongs to an OLDER, not-yet-finalized day gets caught by
      // finalizeClosedDays() the next time it runs (that pass reads full
      // content, not mtime, and finalizes every day it discovers).
      const mtimeDate = localDate(new Date(stat.mtimeMs));
      if (mtimeDate < today && finalizedDates.has(mtimeDate)) continue;

      const t1 = Date.now();
      const { result: parsed, cacheHit } = await parseJSONL(filePath, stat);
      if (!cacheHit) parseBudgetSpentMs += Date.now() - t1;

      if (parsed.skipped) { skippedLargeFiles++; continue; }

      const { sessionDate } = parsed;
      // Inclusive upper bound — `>=` here previously meant "today's data is
      // always dropped", which combined with the (then-UTC) date bucket to
      // hide a Pacific-time user's most recent activity entirely.
      if (!sessionDate || sessionDate < effectiveFrom || sessionDate > effectiveTo) continue;

      // Content-confirmed finalized day (mtime heuristic above missed it) —
      // the rollup is authoritative; don't double count.
      if (sessionDate < today && finalizedDates.has(sessionDate)) continue;

      const key = `${sessionDate}|${encodedCwd}`;
      if (!buckets.has(key)) buckets.set(key, emptyBucket(sessionDate, encodedCwd));
      foldParsedIntoBucket(buckets.get(key), parsed);

      if (!cacheHit && parseBudgetSpentMs > PARSE_BUDGET_MS) {
        skippedBudgetFiles++;
        truncated = true;
        console.warn(
          `[historyAggregator] aggregate: parse budget exhausted after ${parseBudgetSpentMs}ms; ` +
          `at least ${skippedBudgetFiles} file(s) skipped`
        );
        break outer;
      }
    }
  }

  // Self-healing backfill: any past (pre-today) day we just live-parsed was
  // walked in full above (the file walk isn't restricted to a single day), so
  // fold it into the rollup now — it'll be trusted outright once the next
  // finalize pass stamps it `finalizedAt`.
  const backfillEntries = [];
  for (const b of buckets.values()) {
    if (b.date < today) backfillEntries.push(...bucketToRollupLines(b));
  }
  if (backfillEntries.length) {
    await historyRollup.appendRollupDays(backfillEntries);
  }

  const rollupRows = rollupMapToRows(rollupMap, finalizedDates);
  const allBucketEntries = [...rollupRows.values(), ...buckets.values()];

  let cacheSavingsUsd = 0;
  const rows = allBucketEntries.map((b) => {
    const byModel = {};
    let estimatedCostUsd = 0;
    for (const [modelId, bucket] of Object.entries(b.byModel)) {
      const { key, estimated } = resolvePricingKey(modelId);
      const pricing = MODEL_PRICING[key];
      const costUsd =
        (bucket.inputTokens + bucket.cacheCreationTokens) * pricing.i / 1e6 +
        bucket.outputTokens * pricing.o / 1e6 +
        bucket.cacheReadTokens * pricing.c / 1e6;
      byModel[modelId] = { ...bucket, costUsd, ...(estimated ? { estimated: true } : {}) };
      estimatedCostUsd += costUsd;
      // What those cache-read tokens would have cost at the full input rate,
      // minus what they actually cost at the cache rate.
      cacheSavingsUsd += bucket.cacheReadTokens * (pricing.i - pricing.c) / 1e6;
    }
    return { ...b, byModel, estimatedCostUsd };
  });

  rows.sort((a, b) => a.date.localeCompare(b.date) || a.projectCwd.localeCompare(b.projectCwd));

  const rollupDays = new Set(Array.from(rollupRows.values()).map((r) => r.date)).size;
  const liveDays = new Set(Array.from(buckets.values()).map((r) => r.date)).size;

  const scannedMs = Date.now() - t0;
  return { rows, partial: truncated, truncated, scannedMs, skippedLargeFiles, cacheSavingsUsd, rollupDays, liveDays };
}

// ── IPC registration ──────────────────────────────────────────────────────────

function registerHistoryAggregatorHandlers() {
  ipcMain.handle('history:aggregate', async (_e, rawReq) => {
    // Wire the historyAggregate schema (previously defined but never used).
    // safeParse so a malformed payload still falls through to defaults
    // (today − 30d) rather than throwing — matches the current "best-effort"
    // semantics expected by the History tab.
    const parsed = schemas.historyAggregate.safeParse(rawReq);
    const req = parsed.success ? (parsed.data ?? {}) : {};
    return aggregate(req);
  });

  /** Flat list of all JSONL session files — sessionId, project, mtime, size.
   *  Single main-side scan replaces the renderer's serial per-dir IPC loop. */
  ipcMain.handle('history:scan-projects', async () => {
    const t0 = Date.now();
    const sessions = [];
    let projectDirs;
    try {
      projectDirs = await fsp.readdir(PROJECTS_DIR, { withFileTypes: true });
    } catch {
      return { sessions: [], scannedMs: 0 };
    }
    for (const proj of projectDirs) {
      if (!proj.isDirectory()) continue;
      const projectDir = path.join(PROJECTS_DIR, proj.name);
      let files;
      try { files = await fsp.readdir(projectDir, { withFileTypes: true }); } catch { continue; }
      for (const f of files) {
        if (!f.isFile() || !f.name.endsWith('.jsonl')) continue;
        const filePath = path.join(projectDir, f.name);
        let stat;
        try { stat = await fsp.stat(filePath); } catch { continue; }
        sessions.push({
          sessionId: f.name.replace(/\.jsonl$/, ''),
          projectEncoded: proj.name,
          path: filePath,
          mtimeMs: stat.mtimeMs,
          sizeBytes: stat.size,
        });
      }
    }
    sessions.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return { sessions, scannedMs: Date.now() - t0 };
  });
}

const remote = { aggregate };

module.exports = {
  registerHistoryAggregatorHandlers,
  remote,
  MODEL_PRICING,
  finalizeClosedDays,
  refreshIntradayToday,
  computeIntradayBuckets,
  // exported for tests
  scanAggrLines,
  parseJSONL,
  resolvePricingKey,
  CACHE_MAX,
  LRUCache,
  computeActiveMinutes,
  mapWithConcurrency,
  resetIntradayRegistryForTests,
  INTRADAY_STAT_CONCURRENCY,
  // exported for historyDashboard.cjs (pure, no I/O at require-time; reused
  // rather than re-implemented so date-range math stays in one place)
  localDate,
  subtractDays,
};

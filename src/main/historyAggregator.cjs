'use strict';

const { ipcMain } = require('electron');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { schemas } = require('./ipcSchemas.cjs');

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const PARSE_BUDGET_MS = 2_000;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const CACHE_MAX = 500;

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

/**
 * Cache for parseConversationMeta results.
 * Entry shape: { mtimeMs: number, size: number, readOffset: number, inode: number, result: MetaResult }
 */
const metaCache = new LRUCache(CACHE_MAX);

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
 * Returns the first timestamp seen when captureFirst=true, else null.
 */
function scanAggrLines(lines, acc, captureFirst) {
  let firstTs = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }

    if (captureFirst && firstTs === null) {
      const ts = obj.ts ?? obj.timestamp;
      if (ts) firstTs = ts;
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
  return firstTs;
}

/**
 * Scan JSONL lines into a conversation-meta accumulator (mutates meta).
 * captureFirst=true: record the first timestamp seen as meta.firstTs.
 */
function scanMetaLines(lines, meta, captureFirst) {
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    const ts = obj.ts ?? obj.timestamp;
    if (ts) {
      if (captureFirst && meta.firstTs === null) meta.firstTs = ts;
      meta.lastTs = ts;
    }
    const usage = obj.usage ?? obj.message?.usage;
    if (usage && typeof usage === 'object') {
      const inT = usage.input_tokens ?? usage.inputTokens;
      const outT = usage.output_tokens ?? usage.outputTokens;
      if (typeof inT === 'number') meta.inputTokens += inT;
      if (typeof outT === 'number') meta.outputTokens += outT;
    }
  }
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
    errorCount: 0,
    sessionDate: null,
    skipped: false,
  });

  if (stat.size > MAX_FILE_BYTES) {
    return { result: { ...emptyAcc(), skipped: true }, cacheHit: false };
  }

  const cached = aggrCache.get(filePath);
  if (cached) {
    if (cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
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
          scanAggrLines(tail.split('\n'), delta, false);
          const prev = cached.result;
          const merged = {
            promptCount: prev.promptCount + delta.promptCount,
            inputTokens: prev.inputTokens + delta.inputTokens,
            outputTokens: prev.outputTokens + delta.outputTokens,
            cacheReadTokens: prev.cacheReadTokens + delta.cacheReadTokens,
            cacheCreationTokens: prev.cacheCreationTokens + delta.cacheCreationTokens,
            toolCallCount: prev.toolCallCount + delta.toolCallCount,
            toolBreakdown: { ...prev.toolBreakdown },
            errorCount: prev.errorCount + delta.errorCount,
            sessionDate: prev.sessionDate, // firstTs doesn't change on appends
            skipped: false,
          };
          for (const [k, v] of Object.entries(delta.toolBreakdown)) {
            merged.toolBreakdown[k] = (merged.toolBreakdown[k] ?? 0) + v;
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
  const firstTs = scanAggrLines(text.split('\n'), acc, true);

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

/**
 * Parse a JSONL transcript for per-conversation metadata.
 * Returns { result, cacheHit } — same caching strategy as parseJSONL.
 */
async function parseConversationMeta(filePath, stat) {
  const emptyMeta = () => ({
    firstTs: null,
    lastTs: null,
    inputTokens: 0,
    outputTokens: 0,
    skipped: false,
  });

  if (stat.size > MAX_FILE_BYTES) {
    return { result: { ...emptyMeta(), skipped: true }, cacheHit: false };
  }

  const cached = metaCache.get(filePath);
  if (cached) {
    if (cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
      return { result: cached.result, cacheHit: true };
    }

    if (stat.size > cached.size) {
      if (cached.inode !== undefined && cached.inode !== stat.ino) {
        // inode changed → file replaced; fall through to full parse
      } else {
        try {
          const readFrom = cached.readOffset ?? cached.size;
          const tail = await readSlice(filePath, readFrom, stat.size);
          const delta = emptyMeta();
          scanMetaLines(tail.split('\n'), delta, false);
          const prev = cached.result;
          const merged = {
            firstTs: prev.firstTs, // first timestamp never changes on appends
            lastTs: delta.lastTs ?? prev.lastTs,
            inputTokens: prev.inputTokens + delta.inputTokens,
            outputTokens: prev.outputTokens + delta.outputTokens,
            skipped: false,
          };
          const lastNl = tail.lastIndexOf('\n');
          const readOffset = lastNl >= 0 ? readFrom + lastNl + 1 : readFrom;
          metaCache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, readOffset, inode: stat.ino, result: merged });
          return { result: merged, cacheHit: false };
        } catch {
          // fall through to full parse
        }
      }
    }
  }

  // Full parse
  let text;
  try { text = await fsp.readFile(filePath, 'utf8'); } catch {
    return { result: emptyMeta(), cacheHit: false };
  }

  const meta = emptyMeta();
  scanMetaLines(text.split('\n'), meta, true);
  const lastNlMeta = text.lastIndexOf('\n');
  const readOffsetMeta = lastNlMeta >= 0 ? lastNlMeta + 1 : 0;
  metaCache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, readOffset: readOffsetMeta, inode: stat.ino, result: meta });
  return { result: meta, cacheHit: false };
}

// ── aggregate ─────────────────────────────────────────────────────────────────

async function aggregate(req) {
  const t0 = Date.now();
  const today = localDate(new Date());
  let effectiveTo = req?.toDate ? req.toDate : today;
  if (effectiveTo > today) effectiveTo = today;
  const effectiveFrom = req?.fromDate ? req.fromDate : subtractDays(today, 30);

  const buckets = new Map();
  let truncated = false;
  let skippedLargeFiles = 0;
  let skippedBudgetFiles = 0;
  let parseBudgetSpentMs = 0;

  let projectDirs;
  try {
    projectDirs = await fsp.readdir(PROJECTS_DIR, { withFileTypes: true });
  } catch {
    return { rows: [], partial: false, truncated: false, scannedMs: Date.now() - t0 };
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

      const t1 = Date.now();
      const { result: parsed, cacheHit } = await parseJSONL(filePath, stat);
      if (!cacheHit) parseBudgetSpentMs += Date.now() - t1;

      if (parsed.skipped) { skippedLargeFiles++; continue; }

      const { sessionDate } = parsed;
      // Inclusive upper bound — `>=` here previously meant "today's data is
      // always dropped", which combined with the (then-UTC) date bucket to
      // hide a Pacific-time user's most recent activity entirely.
      if (!sessionDate || sessionDate < effectiveFrom || sessionDate > effectiveTo) continue;

      const key = `${sessionDate}|${encodedCwd}`;
      if (!buckets.has(key)) {
        buckets.set(key, {
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
          sessionCount: 0,
          errorCount: 0,
        });
      }

      const b = buckets.get(key);
      b.promptCount += parsed.promptCount;
      b.inputTokens += parsed.inputTokens;
      b.outputTokens += parsed.outputTokens;
      b.cacheReadTokens += parsed.cacheReadTokens;
      b.cacheCreationTokens += parsed.cacheCreationTokens;
      b.toolCallCount += parsed.toolCallCount;
      for (const [tool, cnt] of Object.entries(parsed.toolBreakdown)) {
        b.toolBreakdown[tool] = (b.toolBreakdown[tool] ?? 0) + cnt;
      }
      b.sessionCount++;
      b.errorCount += parsed.errorCount;

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

  const rows = Array.from(buckets.values()).map((b) => ({
    ...b,
    estimatedCostUsd: (b.inputTokens * 3 + b.outputTokens * 15) / 1_000_000,
  }));

  rows.sort((a, b) => a.date.localeCompare(b.date) || a.projectCwd.localeCompare(b.projectCwd));

  const scannedMs = Date.now() - t0;
  return { rows, partial: truncated, truncated, scannedMs, skippedLargeFiles };
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

  /** Per-conversation metadata: one row per JSONL with derived duration +
   *  token totals. Used by the Overview detailed-stats panel to compute
   *  hourly/daily distribution + top-projects. */
  ipcMain.handle('history:list-conversations', async () => {
    const t0 = Date.now();
    const conversations = [];
    let truncated = false;
    let skippedBudgetFiles = 0;
    let parseBudgetSpentMs = 0;

    let projectEntries;
    try {
      projectEntries = await fsp.readdir(PROJECTS_DIR, { withFileTypes: true });
    } catch {
      return { conversations: [], truncated: false, scannedMs: Date.now() - t0 };
    }

    outer:
    for (const ent of projectEntries) {
      if (!ent.isDirectory()) continue;
      const projectDir = path.join(PROJECTS_DIR, ent.name);
      const projectFolder = '/' + ent.name.replace(/-/g, '/');
      let files;
      try { files = await fsp.readdir(projectDir, { withFileTypes: true }); } catch { continue; }

      for (const f of files) {
        if (!f.isFile() || !f.name.endsWith('.jsonl')) continue;
        const filePath = path.join(projectDir, f.name);
        let stat;
        try { stat = await fsp.stat(filePath); } catch { continue; }

        const t1 = Date.now();
        const { result: meta, cacheHit } = await parseConversationMeta(filePath, stat);
        if (!cacheHit) parseBudgetSpentMs += Date.now() - t1;

        if (!meta.skipped) {
          const firstTs = meta.firstTs || new Date(stat.mtimeMs).toISOString();
          const duration =
            meta.firstTs && meta.lastTs
              ? Math.max(0, Date.parse(meta.lastTs) - Date.parse(meta.firstTs))
              : undefined;
          conversations.push({
            timestamp: firstTs,
            projectFolder,
            stats: {
              ...(duration !== undefined ? { duration } : {}),
              estimatedTokens: meta.inputTokens + meta.outputTokens,
            },
          });
        }

        if (!cacheHit && parseBudgetSpentMs > PARSE_BUDGET_MS) {
          skippedBudgetFiles++;
          truncated = true;
          console.warn(
            `[historyAggregator] list-conversations: parse budget exhausted after ${parseBudgetSpentMs}ms; ` +
            `at least ${skippedBudgetFiles} file(s) skipped`
          );
          break outer;
        }
      }
    }

    return { conversations, truncated, scannedMs: Date.now() - t0 };
  });
}

const remote = { aggregate };

module.exports = { registerHistoryAggregatorHandlers, remote };

'use strict';

const { ipcMain } = require('electron');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { schemas } = require('./ipcSchemas.cjs');

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const SLOW_THRESHOLD_MS = 2_000;
const MAX_FILE_BYTES = 20 * 1024 * 1024;

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

async function parseJSONL(filePath, stat) {
  const acc = {
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
  };

  if (stat.size > MAX_FILE_BYTES) {
    acc.skipped = true;
    return acc;
  }

  let text;
  try {
    text = await fsp.readFile(filePath, 'utf8');
  } catch {
    return acc;
  }

  const lines = text.split('\n');
  let firstTs = null;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }

    if (firstTs === null) {
      const ts = obj.ts ?? obj.timestamp;
      if (ts) firstTs = ts;
    }

    const role = obj.role ?? obj.message?.role;
    if (role === 'user') acc.promptCount++;

    const usage = obj.usage ?? obj.message?.usage;
    if (usage && typeof usage === 'object') {
      // Claude Code JSONLs use snake_case (matching the Anthropic API). The
      // previous camelCase-only check meant every token count read as 0.
      // Accept both shapes for forward-compat with any future renderer-side
      // emitter (live.ts already normalizes both).
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

  try {
    acc.sessionDate = firstTs
      ? localDate(new Date(firstTs))
      : localDate(new Date(stat.mtimeMs));
  } catch {
    acc.sessionDate = localDate(new Date(stat.mtimeMs));
  }

  return acc;
}

/** Lightweight per-file meta: { firstTs, lastTs, inputTokens, outputTokens, skipped }.
 *  Powers the `history:list-conversations` IPC used by the Overview detailed-
 *  stats panel. Single-pass O(L) scan, only honors ts + usage blocks. */
async function parseConversationMeta(filePath, stat) {
  const meta = { firstTs: null, lastTs: null, inputTokens: 0, outputTokens: 0, skipped: false };
  if (stat.size > MAX_FILE_BYTES) { meta.skipped = true; return meta; }
  let text;
  try { text = await fsp.readFile(filePath, 'utf8'); } catch { return meta; }
  const lines = text.split('\n');
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    const ts = obj.ts ?? obj.timestamp;
    if (ts) {
      if (meta.firstTs === null) meta.firstTs = ts;
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
  return meta;
}

async function aggregate(req) {
    const t0 = Date.now();
    const today = localDate(new Date());
    let effectiveTo = req?.toDate ? req.toDate : today;
    if (effectiveTo > today) effectiveTo = today;
    const effectiveFrom = req?.fromDate ? req.fromDate : subtractDays(today, 30);

    const buckets = new Map();
    let partial = false;
    let skippedLargeFiles = 0;

    let projectDirs;
    try {
      projectDirs = await fsp.readdir(PROJECTS_DIR, { withFileTypes: true });
    } catch {
      return { rows: [], partial: false, scannedMs: Date.now() - t0 };
    }

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
        try {
          stat = await fsp.stat(filePath);
        } catch {
          continue;
        }

        const parsed = await parseJSONL(filePath, stat);
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
      }

      if (Date.now() - t0 > SLOW_THRESHOLD_MS) {
        console.warn(`[historyAggregator] slow scan: ${Date.now() - t0}ms`);
        partial = true;
        break;
      }
    }

    const rows = Array.from(buckets.values()).map((b) => ({
      ...b,
      estimatedCostUsd: (b.inputTokens * 3 + b.outputTokens * 15) / 1_000_000,
    }));

    rows.sort((a, b) => a.date.localeCompare(b.date) || a.projectCwd.localeCompare(b.projectCwd));

    const scannedMs = Date.now() - t0;
    return { rows, partial, scannedMs, skippedLargeFiles };
}

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

  /** Per-conversation metadata: one row per JSONL with derived duration +
   *  token totals. Used by the Overview detailed-stats panel to compute
   *  hourly/daily distribution + top-projects. */
  ipcMain.handle('history:list-conversations', async () => {
    const t0 = Date.now();
    const conversations = [];
    let projectEntries;
    try {
      projectEntries = await fsp.readdir(PROJECTS_DIR, { withFileTypes: true });
    } catch {
      return { conversations: [], scannedMs: Date.now() - t0 };
    }
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
        const meta = await parseConversationMeta(filePath, stat);
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
    }
    return { conversations, scannedMs: Date.now() - t0 };
  });
}

const remote = { aggregate };

module.exports = { registerHistoryAggregatorHandlers, remote };

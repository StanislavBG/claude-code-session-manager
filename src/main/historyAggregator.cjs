'use strict';

const { ipcMain } = require('electron');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const SLOW_THRESHOLD_MS = 2_000;
const MAX_FILE_BYTES = 20 * 1024 * 1024;

function decodeCwd(encoded) {
  return '/' + encoded.replace(/-+/g, '/');
}

function subtractDays(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
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
      if (typeof usage.inputTokens === 'number') acc.inputTokens += usage.inputTokens;
      if (typeof usage.outputTokens === 'number') acc.outputTokens += usage.outputTokens;
      if (typeof usage.cacheReadInputTokens === 'number') acc.cacheReadTokens += usage.cacheReadInputTokens;
      if (typeof usage.cacheCreationInputTokens === 'number') acc.cacheCreationTokens += usage.cacheCreationInputTokens;
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
      ? new Date(firstTs).toISOString().slice(0, 10)
      : new Date(stat.mtimeMs).toISOString().slice(0, 10);
  } catch {
    acc.sessionDate = new Date(stat.mtimeMs).toISOString().slice(0, 10);
  }

  return acc;
}

function registerHistoryAggregatorHandlers() {
  ipcMain.handle('history:aggregate', async (_e, req) => {
    const t0 = Date.now();
    const today = new Date().toISOString().slice(0, 10);
    let effectiveTo = (req?.toDate && /^\d{4}-\d{2}-\d{2}$/.test(req.toDate)) ? req.toDate : today;
    if (effectiveTo > today) effectiveTo = today;
    const effectiveFrom = (req?.fromDate && /^\d{4}-\d{2}-\d{2}$/.test(req.fromDate))
      ? req.fromDate
      : subtractDays(today, 30);

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
        if (!sessionDate || sessionDate < effectiveFrom || sessionDate >= effectiveTo) continue;

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
  });
}

module.exports = { registerHistoryAggregatorHandlers };

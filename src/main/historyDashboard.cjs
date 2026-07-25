/**
 * historyDashboard.cjs — `history:dashboard` IPC: answers entirely from the
 * durable rollup store (src/main/lib/historyRollup.cjs), never touching a
 * transcript .jsonl file. This is what lets the History dashboard render
 * instantly regardless of transcript corpus size or retention/cleanup.
 *
 * Only imports historyRollup.cjs (the rollup reader) and pure helpers
 * re-exported from historyAggregator.cjs (pricing table + date math) — never
 * fs/promises, never PROJECTS_DIR. See historyDashboard.test.cjs's zero-scan
 * guarantee test.
 */

'use strict';

const { ipcMain } = require('electron');
const historyRollup = require('./lib/historyRollup.cjs');
const {
  MODEL_PRICING,
  resolvePricingKey,
  localDate,
  subtractDays,
} = require('./historyAggregator.cjs');
const { schemas } = require('./ipcSchemas.cjs');

// Read range start for rangeDays=0 ("all time"). Rollup dates are always
// after this, so it's an effective "no lower bound".
const EARLIEST_DATE = '1970-01-01';

function emptyProjectRow(date, projectDir) {
  return {
    date,
    projectDir,
    promptCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    toolCallCount: 0,
    toolBreakdown: {},
    sessionCount: 0,
    errorCount: 0,
    activeMinutes: 0,
    byModel: {},
  };
}

/** Fold one rollup bucket (totals line or per-model line) into a row. */
function foldBucketIntoRow(row, bucket) {
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

/** Compute per-model + row-level cost at read time — never stored. */
function computeRowCost(row) {
  const byModel = {};
  let estimatedCostUsd = 0;
  for (const [modelId, bucket] of Object.entries(row.byModel)) {
    const { key, estimated } = resolvePricingKey(modelId);
    const pricing = MODEL_PRICING[key];
    const costUsd =
      (bucket.inputTokens + bucket.cacheCreationTokens) * pricing.i / 1e6 +
      bucket.outputTokens * pricing.o / 1e6 +
      bucket.cacheReadTokens * pricing.c / 1e6;
    byModel[modelId] = { ...bucket, costUsd, ...(estimated ? { estimated: true } : {}) };
    estimatedCostUsd += costUsd;
  }
  return { ...row, byModel, estimatedCostUsd };
}

function emptyTotals() {
  return {
    promptCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    toolCallCount: 0,
    sessionCount: 0,
    errorCount: 0,
    activeMinutes: 0,
    estimatedCostUsd: 0,
  };
}

function addRowToTotals(totals, row) {
  totals.promptCount += row.promptCount;
  totals.inputTokens += row.inputTokens;
  totals.outputTokens += row.outputTokens;
  totals.cacheReadTokens += row.cacheReadTokens;
  totals.cacheCreationTokens += row.cacheCreationTokens;
  totals.toolCallCount += row.toolCallCount;
  totals.sessionCount += row.sessionCount;
  totals.errorCount += row.errorCount;
  totals.activeMinutes += row.activeMinutes;
  totals.estimatedCostUsd += row.estimatedCostUsd;
}

/**
 * Answer the History dashboard's full request purely from rollup lines.
 * O(rollup lines in range) — no transcript file is ever opened.
 */
async function computeDashboard(req) {
  const rangeDays = req?.rangeDays ?? 30;
  const isAll = rangeDays === 0;
  const today = localDate(new Date());
  const to = today;
  const from = isAll ? EARLIEST_DATE : subtractDays(today, rangeDays - 1);
  const prevFrom = isAll ? null : subtractDays(from, rangeDays);
  const prevTo = isAll ? null : subtractDays(from, 1);
  const readFrom = isAll ? EARLIEST_DATE : prevFrom;

  const map = await historyRollup.readRollup(readFrom, to);

  const daysMap = new Map(); // date -> Map(projectDir -> row)
  const prevRow = emptyProjectRow('', '');
  const finalizedDates = new Set();

  for (const bucket of map.values()) {
    if (bucket.projectDir === historyRollup.FINALIZED_PROJECT_ID && bucket.modelId === historyRollup.FINALIZED_MODEL_ID) {
      if (bucket.finalizedAt) finalizedDates.add(bucket.date);
      continue;
    }

    const inCurrent = bucket.date >= from && bucket.date <= to;
    if (inCurrent) {
      let projMap = daysMap.get(bucket.date);
      if (!projMap) { projMap = new Map(); daysMap.set(bucket.date, projMap); }
      let row = projMap.get(bucket.projectDir);
      if (!row) { row = emptyProjectRow(bucket.date, bucket.projectDir); projMap.set(bucket.projectDir, row); }
      foldBucketIntoRow(row, bucket);
      continue;
    }

    const inPrev = !isAll && bucket.date >= prevFrom && bucket.date <= prevTo;
    if (inPrev) foldBucketIntoRow(prevRow, bucket);
  }

  const days = [];
  const totals = emptyTotals();
  const byProjectTotals = {};
  const byModelTotals = {};
  const toolsByProject = {};

  const sortedDates = Array.from(daysMap.keys()).sort();
  for (const date of sortedDates) {
    const projMap = daysMap.get(date);
    const byProject = {};
    for (const [projectDir, row] of projMap) {
      const rowWithCost = computeRowCost(row);
      byProject[projectDir] = rowWithCost;
      addRowToTotals(totals, rowWithCost);

      if (!byProjectTotals[projectDir]) byProjectTotals[projectDir] = emptyTotals();
      addRowToTotals(byProjectTotals[projectDir], rowWithCost);

      if (!toolsByProject[projectDir]) toolsByProject[projectDir] = {};
      for (const [tool, cnt] of Object.entries(row.toolBreakdown)) {
        toolsByProject[projectDir][tool] = (toolsByProject[projectDir][tool] ?? 0) + cnt;
      }

      for (const [modelId, mb] of Object.entries(rowWithCost.byModel)) {
        const dst = byModelTotals[modelId] ?? (byModelTotals[modelId] = {
          inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0,
        });
        dst.inputTokens += mb.inputTokens;
        dst.outputTokens += mb.outputTokens;
        dst.cacheReadTokens += mb.cacheReadTokens;
        dst.cacheCreationTokens += mb.cacheCreationTokens;
        dst.costUsd += mb.costUsd;
        if (mb.estimated) dst.estimated = true;
      }
    }
    days.push({ date, byProject });
  }

  const prevTotals = emptyTotals();
  addRowToTotals(prevTotals, computeRowCost(prevRow));

  const provisionalDates = sortedDates.filter((d) => !finalizedDates.has(d));

  return {
    from,
    to,
    days,
    prevTotals,
    totals,
    byProjectTotals,
    byModelTotals,
    toolsByProject,
    generatedAt: Date.now(),
    provisionalDates,
  };
}

function registerHistoryDashboardHandlers() {
  ipcMain.handle('history:dashboard', async (_e, rawReq) => {
    const parsed = schemas.historyDashboard.safeParse(rawReq);
    const req = parsed.success ? parsed.data : { rangeDays: 30 };
    return computeDashboard(req);
  });
}

module.exports = {
  registerHistoryDashboardHandlers,
  computeDashboard,
};

/**
 * historyDashboard.cjs — `history:dashboard` IPC: answers entirely from the
 * durable rollup store (src/main/lib/historyRollup.cjs), never touching a
 * transcript .jsonl file. This is what lets the History dashboard render
 * instantly regardless of transcript corpus size or retention/cleanup.
 *
 * Only imports historyRollup.cjs (the rollup reader) and pure helpers
 * re-exported from historyAggregator.cjs (date math) plus lib/claude/modelPricing.cjs (cost) — never
 * fs/promises, never PROJECTS_DIR. See historyDashboard.test.cjs's zero-scan
 * guarantee test.
 *
 * The one non-rollup input is the Task ledger (lib/tasks/taskLedger.cjs
 * readTaskUsageDays, for every project in lib/tasks/taskSwitch.cjs
 * listTaskProjects, switch on or off). It is still no transcript scan and no
 * PROJECTS_DIR: each project's own session-manager-operations/tasks/ day files.
 * Its spend lands as rows keyed 'sm-task:<absolute cwd>' so the renderer fold
 * puts it on that project's row. Nothing counts twice: Tasks run with
 * --no-session-persistence and write no transcript, and historyAggregator.cjs
 * skips the transcript of any Task that did persist (sibling PRD
 * task-history-skip-task-transcripts), so no rollup line carries Task usage.
 */

'use strict';

const { ipcMain } = require('electron');
const historyRollup = require('./lib/historyRollup.cjs');
const { localDate, subtractDays } = require('./historyAggregator.cjs');
const { costOfUsage } = require('./lib/claude/modelPricing.cjs');
const { schemas } = require('./ipcSchemas.cjs');

// Read range start for rangeDays=0 ("all time"). Rollup dates are always
// after this, so it's an effective "no lower bound".
const EARLIEST_DATE = '1970-01-01';

/** Prefix of a Task project's row key in days[].byProject: 'sm-task:' + absolute cwd. */
const TASK_PROJECT_PREFIX = 'sm-task:';

/**
 * Default Task readers, required lazily so a dashboard that never reaches
 * them (and the zero-scan test's module graph) stays as it was.
 */
function defaultTaskDeps() {
  return {
    listTaskProjects: () => require('./lib/tasks/taskSwitch.cjs').listTaskProjects(),
    readTaskUsageDays: (cwd, range) => require('./lib/tasks/taskLedger.cjs').readTaskUsageDays(cwd, range),
  };
}

/**
 * Task ledger days → buckets shaped like rollup lines: per day, one totals
 * bucket (promptCount = sessionCount = task count) and one bucket per model,
 * so they go through the same fold + cost path as transcript rows.
 */
async function readTaskBuckets(from, to, deps) {
  const listTaskProjects = deps.listTaskProjects ?? defaultTaskDeps().listTaskProjects;
  const readTaskUsageDays = deps.readTaskUsageDays ?? defaultTaskDeps().readTaskUsageDays;
  const buckets = [];
  for (const { cwd } of listTaskProjects() || []) {
    if (typeof cwd !== 'string' || !cwd) continue;
    let days;
    try {
      days = await readTaskUsageDays(cwd, { sinceDate: from, untilDate: to });
    } catch (err) {
      console.warn(`[historyDashboard] Task ledger read failed for ${cwd}:`, err);
      continue;
    }
    const projectDir = TASK_PROJECT_PREFIX + cwd;
    for (const d of days || []) {
      buckets.push({
        date: d.date, projectDir, modelId: historyRollup.TOTALS_MODEL_ID,
        promptCount: d.tasks || 0, sessionCount: d.tasks || 0,
      });
      for (const [modelId, m] of Object.entries(d.byModel || {})) {
        buckets.push({
          date: d.date, projectDir, modelId,
          inputTokens: m.input_tokens || 0,
          outputTokens: m.output_tokens || 0,
          cacheReadTokens: m.cache_read_input_tokens || 0,
          cacheCreationTokens: m.cache_creation_input_tokens || 0,
        });
      }
    }
  }
  return buckets;
}

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
      cacheCreation1hTokens: 0, cacheCreationUnknownTokens: 0,
    });
    dst.inputTokens += bucket.inputTokens || 0;
    dst.outputTokens += bucket.outputTokens || 0;
    dst.cacheReadTokens += bucket.cacheReadTokens || 0;
    dst.cacheCreationTokens += bucket.cacheCreationTokens || 0;
    // A line written before rollup v4 has no 1-hour split: its cache writes
    // count as unknown, which costOfUsage prices at the 1-hour rate and marks
    // estimated. Both parts are plain sums, so a bucket mixing old and new
    // lines (e.g. the previous-period row) stays right.
    if (typeof bucket.cacheCreation1hTokens === 'number') {
      dst.cacheCreation1hTokens += bucket.cacheCreation1hTokens;
    } else {
      dst.cacheCreationUnknownTokens += bucket.cacheCreationTokens || 0;
    }
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
    const { costUsd, estimated } = costOfUsage(modelId, bucket);
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
 * Answer the History dashboard's full request from rollup lines plus the Task
 * ledger. O(rollup lines + Task ledger lines in range) — no transcript file is
 * ever opened. `deps` ({ listTaskProjects, readTaskUsageDays }) is for tests.
 */
async function computeDashboard(req, deps = {}) {
  const rangeDays = req?.rangeDays ?? 30;
  const isAll = rangeDays === 0;
  const today = localDate(new Date());
  const to = today;
  const from = isAll ? EARLIEST_DATE : subtractDays(today, rangeDays - 1);
  const prevFrom = isAll ? null : subtractDays(from, rangeDays);
  const prevTo = isAll ? null : subtractDays(from, 1);
  const readFrom = isAll ? EARLIEST_DATE : prevFrom;

  const map = await historyRollup.readRollup(readFrom, to);
  const taskBuckets = await readTaskBuckets(readFrom, to, deps);

  const daysMap = new Map(); // date -> Map(projectDir -> row)
  const prevRow = emptyProjectRow('', '');
  const finalizedDates = new Set();

  for (const bucket of [...map.values(), ...taskBuckets]) {
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
  // Days finalized under an older ROLLUP_VERSION that the finalize pass could
  // not recount (transcripts gone) — their rows are still served as-is.
  const legacyDates = historyRollup.legacyFinalizedDates(map).filter((d) => d >= from && d <= to);

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
    legacyDates,
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
  TASK_PROJECT_PREFIX,
};

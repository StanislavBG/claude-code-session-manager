/**
 * historyDashboardTasks.test.cjs — Task ledger spend joined into the
 * `history:dashboard` answer as 'sm-task:<cwd>' rows (src/main/historyDashboard.cjs).
 *
 * Run: timeout 300 npx vitest run src/main/__tests__/historyDashboardTasks.test.cjs
 */

'use strict';

import { test, expect, beforeEach, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let tmpHome;
let realHome;
let projCwd;
let historyRollup;
let historyDashboard;
let taskLedger;
let costOfUsage;

const MODULES_TO_RELOAD = [
  '../lib/historyRollup.cjs',
  '../historyAggregator.cjs',
  '../historyDashboard.cjs',
  '../config.cjs',
  '../lib/tasks/taskLedger.cjs',
];

function purgeRequireCache() {
  for (const m of MODULES_TO_RELOAD) {
    try { delete require.cache[require.resolve(m)]; } catch { /* not loaded yet */ }
  }
}

beforeEach(() => {
  realHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'history-dashboard-tasks-test-'));
  process.env.HOME = tmpHome;
  projCwd = path.join(tmpHome, 'proj-burrow');
  fs.mkdirSync(projCwd, { recursive: true });
  purgeRequireCache();
  historyRollup = require('../lib/historyRollup.cjs');
  historyDashboard = require('../historyDashboard.cjs');
  taskLedger = require('../lib/tasks/taskLedger.cjs');
  ({ costOfUsage } = require('../lib/claude/modelPricing.cjs'));
});

afterEach(() => {
  process.env.HOME = realHome;
  purgeRequireCache();
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

/** Local noon `n` days ago, as an ISO string (keeps the local date stable). */
function noonDaysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  d.setHours(12, 0, 0, 0);
  return d.toISOString();
}

function localDate(iso) {
  return new Date(iso).toLocaleDateString('en-CA');
}

async function addTask(taskId, startedAt, model, usage) {
  await taskLedger.appendTaskStart(projCwd, {
    taskId, cwd: projCwd, agent: 'dev-lead', model, effort: 'medium', startedAt, timeoutSec: 600, prompt: 'p',
  });
  await taskLedger.appendTaskEnd(projCwd, {
    taskId, startedAt, endedAt: startedAt, status: 'ok', exitCode: 0, usage, costUsd: 0.01, output: 'o',
  });
}

async function seedRollup() {
  const d1 = localDate(noonDaysAgo(1));
  await historyRollup.appendRollupDays([
    { date: d1, projectDir: 'proj-a', modelId: historyRollup.TOTALS_MODEL_ID, promptCount: 3, toolCallCount: 1, toolBreakdown: { Edit: 1 }, errorCount: 0, sessionCount: 1, activeMinutes: 8, v: 4 },
    { date: d1, projectDir: 'proj-a', modelId: 'claude-sonnet-5', inputTokens: 500, outputTokens: 100, cacheReadTokens: 0, cacheCreationTokens: 0, cacheCreation1hTokens: 0, v: 4 },
  ]);
}

const OPUS = 'claude-opus-5-5';
const SONNET = 'claude-sonnet-5';

test('3 Tasks on 2 models over 2 days → sm-task rows with the right tokens and cost', async () => {
  await seedRollup();
  const s1 = noonDaysAgo(1);
  const s0 = noonDaysAgo(0);
  const u = (i, o, r, c) => ({ input_tokens: i, output_tokens: o, cache_read_input_tokens: r, cache_creation_input_tokens: c });
  await addTask('t1', s1, OPUS, u(1000, 200, 3000, 400));
  await addTask('t2', s1, SONNET, u(500, 100, 0, 0));
  await addTask('t3', s0, OPUS, u(10, 20, 30, 40));
  // A Task outside a 30-day range is not counted.
  await addTask('t-old', noonDaysAgo(45), OPUS, u(999999, 0, 0, 0));

  const deps = { listTaskProjects: () => [{ cwd: projCwd, enabled: false, changedAt: 1 }] };
  const result = await historyDashboard.computeDashboard({ rangeDays: 30 }, deps);
  const key = `sm-task:${projCwd}`;
  const d1 = localDate(s1);
  const d0 = localDate(s0);

  const row1 = result.days.find((d) => d.date === d1).byProject[key];
  expect(row1.projectDir).toBe(key);
  expect(row1.sessionCount).toBe(2);
  expect(row1.promptCount).toBe(2);
  expect(row1.inputTokens).toBe(1500);
  expect(row1.outputTokens).toBe(300);
  expect(row1.cacheReadTokens).toBe(3000);
  expect(row1.cacheCreationTokens).toBe(400);
  expect(Object.keys(row1.byModel).sort()).toEqual([OPUS, SONNET].sort());
  const opusCost = costOfUsage(OPUS, { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 3000, cacheCreationTokens: 400 }).costUsd;
  const sonnetCost = costOfUsage(SONNET, { inputTokens: 500, outputTokens: 100, cacheReadTokens: 0, cacheCreationTokens: 0 }).costUsd;
  expect(opusCost).toBeGreaterThan(0);
  expect(row1.byModel[OPUS].costUsd).toBeCloseTo(opusCost, 12);
  expect(row1.byModel[SONNET].costUsd).toBeCloseTo(sonnetCost, 12);
  expect(row1.estimatedCostUsd).toBeCloseTo(opusCost + sonnetCost, 12);
  // The transcript row on the same day is untouched.
  expect(result.days.find((d) => d.date === d1).byProject['proj-a'].promptCount).toBe(3);

  const row0 = result.days.find((d) => d.date === d0).byProject[key];
  expect(row0.sessionCount).toBe(1);
  expect(row0.inputTokens).toBe(10);
  expect(Object.keys(row0.byModel)).toEqual([OPUS]);

  expect(result.byProjectTotals[key].sessionCount).toBe(3);
  expect(result.byProjectTotals[key].inputTokens).toBe(1510);
  expect(result.totals.promptCount).toBe(3 + 3);
  expect(result.totals.inputTokens).toBe(500 + 1510);
  expect(result.byModelTotals[OPUS].inputTokens).toBe(1010);
  expect(result.byModelTotals[SONNET].inputTokens).toBe(500 + 500);
  expect(result.toolsByProject[key]).toEqual({});
  // Task-only today has no finalized marker → provisional, as rollup days are.
  expect(result.provisionalDates).toContain(d0);

  // rangeDays=1 → current = today only; yesterday's Tasks fold into prevTotals.
  const one = await historyDashboard.computeDashboard({ rangeDays: 1 }, deps);
  expect(one.days.map((d) => d.date)).toEqual([d0]);
  expect(one.totals.inputTokens).toBe(10);
  expect(one.prevTotals.inputTokens).toBe(500 + 1500);
  expect(one.prevTotals.sessionCount).toBe(1 + 2);
});

test('no Task projects leaves the output unchanged', async () => {
  await seedRollup();
  const strip = (r) => ({ ...r, generatedAt: 0 });
  const before = strip(await historyDashboard.computeDashboard({ rangeDays: 30 }, { listTaskProjects: () => [], readTaskUsageDays: async () => { throw new Error('must not be read'); } }));
  const withProjNoTasks = strip(await historyDashboard.computeDashboard({ rangeDays: 30 }, { listTaskProjects: () => [{ cwd: projCwd, enabled: true, changedAt: 1 }] }));
  const baseline = strip(await historyDashboard.computeDashboard({ rangeDays: 30 }, { listTaskProjects: () => [] }));
  expect(JSON.stringify(withProjNoTasks)).toBe(JSON.stringify(baseline));
  expect(JSON.stringify(before)).toBe(JSON.stringify(baseline));
  expect(Object.keys(baseline.byProjectTotals)).toEqual(['proj-a']);
});

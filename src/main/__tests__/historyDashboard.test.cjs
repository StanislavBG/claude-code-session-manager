/**
 * historyDashboard.test.cjs — unit tests for src/main/historyDashboard.cjs
 * (the `history:dashboard` IPC's pure rollup-only computation).
 *
 * Run: timeout 300 npx vitest run src/main/__tests__/historyDashboard.test.cjs
 */

'use strict';

import { test, expect, beforeEach, afterEach, vi } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let tmpHome;
let realHome;
let historyRollup;
let historyDashboard;

const MODULES_TO_RELOAD = [
  '../lib/historyRollup.cjs',
  '../historyAggregator.cjs',
  '../historyDashboard.cjs',
  '../config.cjs',
];

function purgeRequireCache() {
  for (const m of MODULES_TO_RELOAD) {
    try { delete require.cache[require.resolve(m)]; } catch { /* not loaded yet */ }
  }
}

beforeEach(() => {
  realHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'history-dashboard-test-'));
  process.env.HOME = tmpHome;
  purgeRequireCache();
  historyRollup = require('../lib/historyRollup.cjs');
  historyDashboard = require('../historyDashboard.cjs');
});

afterEach(() => {
  process.env.HOME = realHome;
  purgeRequireCache();
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

function today() {
  return new Date().toLocaleDateString('en-CA');
}

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toLocaleDateString('en-CA');
}

async function seedThreeDayFixture() {
  const d2 = daysAgo(2);
  const d1 = daysAgo(1);
  const d0 = today();

  await historyRollup.appendRollupDays([
    // day -2: project A, finalized, sonnet
    { date: d2, projectDir: 'proj-a', modelId: historyRollup.TOTALS_MODEL_ID, promptCount: 4, toolCallCount: 2, toolBreakdown: { Read: 2 }, errorCount: 0, sessionCount: 1, activeMinutes: 12, v: 2 },
    { date: d2, projectDir: 'proj-a', modelId: 'claude-sonnet-5', promptCount: 0, inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0, cacheCreationTokens: 0, v: 2 },
    { date: d2, projectDir: historyRollup.FINALIZED_PROJECT_ID, modelId: historyRollup.FINALIZED_MODEL_ID, finalizedAt: 111, v: 2 },

    // day -1: project A and B, finalized
    { date: d1, projectDir: 'proj-a', modelId: historyRollup.TOTALS_MODEL_ID, promptCount: 3, toolCallCount: 1, toolBreakdown: { Edit: 1 }, errorCount: 1, sessionCount: 1, activeMinutes: 8, v: 2 },
    { date: d1, projectDir: 'proj-a', modelId: 'claude-sonnet-5', promptCount: 0, inputTokens: 500, outputTokens: 100, cacheReadTokens: 0, cacheCreationTokens: 0, v: 2 },
    { date: d1, projectDir: 'proj-b', modelId: historyRollup.TOTALS_MODEL_ID, promptCount: 2, toolCallCount: 0, toolBreakdown: {}, errorCount: 0, sessionCount: 1, activeMinutes: 5, v: 2 },
    { date: d1, projectDir: 'proj-b', modelId: 'claude-opus-5', promptCount: 0, inputTokens: 300, outputTokens: 50, cacheReadTokens: 0, cacheCreationTokens: 0, v: 2 },
    { date: d1, projectDir: historyRollup.FINALIZED_PROJECT_ID, modelId: historyRollup.FINALIZED_MODEL_ID, finalizedAt: 222, v: 2 },

    // today: provisional, project A only, no finalized marker
    { date: d0, projectDir: 'proj-a', modelId: historyRollup.TOTALS_MODEL_ID, promptCount: 1, toolCallCount: 1, toolBreakdown: { Bash: 1 }, errorCount: 0, sessionCount: 1, activeMinutes: 3, v: 2 },
    { date: d0, projectDir: 'proj-a', modelId: 'claude-sonnet-5', promptCount: 0, inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheCreationTokens: 0, v: 2 },
  ]);

  return { d2, d1, d0 };
}

test('dashboard response shape: 3-day fixture with rangeDays=30 includes all seeded days, correct totals, provisional today', async () => {
  const { d2, d1, d0 } = await seedThreeDayFixture();

  const result = await historyDashboard.computeDashboard({ rangeDays: 30 });

  expect(result.from).toBeTruthy();
  expect(result.to).toBe(d0);
  expect(Array.isArray(result.days)).toBe(true);

  const dates = result.days.map((d) => d.date);
  expect(dates).toContain(d2);
  expect(dates).toContain(d1);
  expect(dates).toContain(d0);

  // provisionalDates: only today (no finalized marker was written for it).
  expect(result.provisionalDates).toEqual([d0]);

  // Totals across all 3 days: promptCount 4+3+2+1 = 10
  expect(result.totals.promptCount).toBe(10);
  expect(result.totals.activeMinutes).toBe(12 + 8 + 5 + 3);

  // byProjectTotals: proj-a spans all 3 days, proj-b only day -1
  expect(result.byProjectTotals['proj-a'].promptCount).toBe(4 + 3 + 1);
  expect(result.byProjectTotals['proj-b'].promptCount).toBe(2);

  // byModelTotals: sonnet appears on all 3 days for proj-a + day -1 for... only proj-a uses sonnet
  expect(result.byModelTotals['claude-sonnet-5'].inputTokens).toBe(1000 + 500 + 100);
  expect(result.byModelTotals['claude-sonnet-5'].costUsd).toBeGreaterThan(0);
  expect(result.byModelTotals['claude-opus-5'].inputTokens).toBe(300);

  // toolsByProject
  expect(result.toolsByProject['proj-a']).toEqual({ Read: 2, Edit: 1, Bash: 1 });
  expect(result.toolsByProject['proj-b']).toEqual({});

  // Per-day, per-project bucket shape.
  const dayMinus2 = result.days.find((d) => d.date === d2);
  expect(dayMinus2.byProject['proj-a'].promptCount).toBe(4);
  expect(dayMinus2.byProject['proj-a'].byModel['claude-sonnet-5'].costUsd).toBeGreaterThan(0);

  expect(typeof result.generatedAt).toBe('number');
});

test('dashboard: rangeDays=0 (all time) includes every day with no prior-window bound, prevTotals stays zero', async () => {
  await seedThreeDayFixture();

  const result = await historyDashboard.computeDashboard({ rangeDays: 0 });
  expect(result.days.length).toBe(3);
  expect(result.prevTotals.promptCount).toBe(0);
  expect(result.prevTotals.estimatedCostUsd).toBe(0);
});

test('dashboard: prevTotals aggregates the prior window distinct from the current window', async () => {
  const d0 = today();
  // Two 1-day windows: rangeDays=1 → current = [today, today], prior = [yesterday, yesterday].
  const yesterday = daysAgo(1);
  await historyRollup.appendRollupDays([
    { date: yesterday, projectDir: 'proj-a', modelId: historyRollup.TOTALS_MODEL_ID, promptCount: 9, sessionCount: 1, activeMinutes: 20, v: 2 },
    { date: yesterday, projectDir: historyRollup.FINALIZED_PROJECT_ID, modelId: historyRollup.FINALIZED_MODEL_ID, finalizedAt: 1, v: 2 },
    { date: d0, projectDir: 'proj-a', modelId: historyRollup.TOTALS_MODEL_ID, promptCount: 2, sessionCount: 1, activeMinutes: 4, v: 2 },
  ]);

  const result = await historyDashboard.computeDashboard({ rangeDays: 1 });
  expect(result.totals.promptCount).toBe(2);
  expect(result.prevTotals.promptCount).toBe(9);
});

test('zero-scan guarantee: computeDashboard never reads PROJECTS_DIR / transcript files', async () => {
  await seedThreeDayFixture();

  const fsp = require('node:fs/promises');
  const PROJECTS_DIR = path.join(tmpHome, '.claude', 'projects');
  const readdirSpy = vi.spyOn(fsp, 'readdir');

  await historyDashboard.computeDashboard({ rangeDays: 30 });

  const scannedProjectsDir = readdirSpy.mock.calls.some((call) => String(call[0]).startsWith(PROJECTS_DIR));
  expect(scannedProjectsDir).toBe(false);

  readdirSpy.mockRestore();
});

test('dashboard: legacyDates lists in-range days whose finalized marker predates ROLLUP_VERSION; their rows are still served', async () => {
  const { d2, d1, d0 } = await seedThreeDayFixture();
  const old = daysAgo(400);
  await historyRollup.appendRollupDays([
    // d1 re-finalized at the current version → no longer legacy.
    { date: d1, projectDir: historyRollup.FINALIZED_PROJECT_ID, modelId: historyRollup.FINALIZED_MODEL_ID, finalizedAt: 333, v: historyRollup.ROLLUP_VERSION },
    // Out-of-range legacy day (outside rangeDays=30) must not appear.
    { date: old, projectDir: 'proj-a', modelId: historyRollup.TOTALS_MODEL_ID, promptCount: 7, sessionCount: 1, activeMinutes: 1, v: 2 },
    { date: old, projectDir: historyRollup.FINALIZED_PROJECT_ID, modelId: historyRollup.FINALIZED_MODEL_ID, finalizedAt: 1, v: 2 },
  ]);

  const result = await historyDashboard.computeDashboard({ rangeDays: 30 });
  expect(result.legacyDates).toEqual([d2]);
  expect(result.days.find((d) => d.date === d2).byProject['proj-a'].promptCount).toBe(4);
  expect(result.provisionalDates).toEqual([d0]);

  const all = await historyDashboard.computeDashboard({ rangeDays: 0 });
  expect(all.legacyDates).toEqual([old, d2]);
});

test('cost: claude-opus-5-5 is priced from modelPricing — output, cache reads and split cache writes', async () => {
  const d1 = daysAgo(1);
  await historyRollup.appendRollupDays([
    { date: d1, projectDir: 'p-out', modelId: 'claude-opus-5-5', inputTokens: 0, outputTokens: 1_000_000, cacheReadTokens: 0, cacheCreationTokens: 0, cacheCreation1hTokens: 0, v: 4 },
    { date: d1, projectDir: 'p-read', modelId: 'claude-opus-5-5', inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000, cacheCreationTokens: 0, cacheCreation1hTokens: 0, v: 4 },
    { date: d1, projectDir: 'p-write', modelId: 'claude-opus-5-5', inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 1_000_000, cacheCreation1hTokens: 400_000, v: 4 },
    { date: d1, projectDir: 'p-nosplit', modelId: 'claude-opus-5-5', inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 1_000_000, v: 3 },
    { date: d1, projectDir: 'p-unknown', modelId: 'mystery-model', inputTokens: 1000, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, cacheCreation1hTokens: 0, v: 4 },
  ]);
  const result = await historyDashboard.computeDashboard({ rangeDays: 30 });
  const day = result.days.find((d) => d.date === d1);
  const m = (p, id = 'claude-opus-5-5') => day.byProject[p].byModel[id];

  expect(m('p-out').costUsd).toBeCloseTo(20, 9);
  expect(m('p-out').estimated).toBeUndefined();
  expect(m('p-read').costUsd).toBeCloseTo(0.20, 9);
  expect(m('p-read').estimated).toBeUndefined();
  expect(m('p-write').costUsd).toBeCloseTo(6.20, 9);
  expect(m('p-write').estimated).toBeUndefined();
  // No recorded 1-hour part: all writes at the 1-hour rate, flagged estimated.
  expect(m('p-nosplit').costUsd).toBeCloseTo(8, 9);
  expect(m('p-nosplit').estimated).toBe(true);
  expect(m('p-unknown', 'mystery-model').estimated).toBe(true);
  expect(day.byProject['p-write'].estimatedCostUsd).toBeCloseTo(6.20, 9);
  expect(result.byModelTotals['claude-opus-5-5'].estimated).toBe(true);
});

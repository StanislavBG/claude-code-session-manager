/**
 * historyRollup.test.cjs — unit tests for src/main/lib/historyRollup.cjs
 * (durable daily rollup) and its integration into historyAggregator.cjs
 * (rollup-first closed-day aggregation, finalize pass, backfill, deleted-file
 * immunity).
 *
 * Run: timeout 300 npx vitest run src/main/__tests__/historyRollup.test.cjs
 */

'use strict';

import { test, expect, beforeEach, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let tmpHome;
let realHome;
let historyRollup;
let historyAggregator;

function encodeCwd(cwd) {
  return cwd.replace(/\//g, '-');
}

function writeTranscript(projectCwd, sessionId, lines, mtime) {
  const encoded = encodeCwd(projectCwd);
  const dir = path.join(tmpHome, '.claude', 'projects', encoded);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');
  if (mtime) fs.utimesSync(file, mtime, mtime);
  return file;
}

function userLine(ts) {
  return { role: 'user', ts };
}

function assistantLine(ts, model, tokens = {}) {
  return {
    ts,
    message: {
      role: 'assistant',
      model,
      usage: {
        input_tokens: tokens.in ?? 10,
        output_tokens: tokens.out ?? 5,
        cache_read_input_tokens: tokens.cacheR ?? 0,
        cache_creation_input_tokens: tokens.cacheC ?? 0,
      },
    },
  };
}

// These modules are required via Node's own require() (this is a .cjs file,
// not transformed ESM), so vi.resetModules() — which only resets vitest's
// ESM module graph — does NOT clear them. Each module also bakes os.homedir()
// into a top-level const (ROLLUP_PATH, config.cjs's allowedRoots/
// WRITE_PREFIXES) at first require. Without purging Node's require.cache here,
// every test after the first would keep writing to the FIRST test's tmpHome.
const MODULES_TO_RELOAD = [
  '../lib/historyRollup.cjs',
  '../historyAggregator.cjs',
  '../config.cjs',
];

function purgeRequireCache() {
  for (const m of MODULES_TO_RELOAD) {
    try { delete require.cache[require.resolve(m)]; } catch { /* not loaded yet */ }
  }
}

beforeEach(() => {
  realHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'history-rollup-test-'));
  process.env.HOME = tmpHome;
  purgeRequireCache();
  historyRollup = require('../lib/historyRollup.cjs');
  historyAggregator = require('../historyAggregator.cjs');
});

afterEach(() => {
  process.env.HOME = realHome;
  purgeRequireCache();
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

test('rollupKey is stable and distinguishes date/project/model', () => {
  const a = historyRollup.rollupKey('2026-07-01', 'proj-a', 'sonnet');
  const b = historyRollup.rollupKey('2026-07-01', 'proj-a', 'opus');
  const c = historyRollup.rollupKey('2026-07-02', 'proj-a', 'sonnet');
  expect(a).not.toBe(b);
  expect(a).not.toBe(c);
  expect(historyRollup.rollupKey('2026-07-01', 'proj-a', 'sonnet')).toBe(a);
});

test('mergeRollupLines: last-write-wins per key', () => {
  const lines = [
    JSON.stringify({ date: '2026-07-01', projectDir: 'p', modelId: 'sonnet', inputTokens: 10 }),
    JSON.stringify({ date: '2026-07-01', projectDir: 'p', modelId: 'sonnet', inputTokens: 99 }),
    JSON.stringify({ date: '2026-07-01', projectDir: 'p', modelId: 'opus', inputTokens: 5 }),
  ];
  const merged = historyRollup.mergeRollupLines(lines);
  expect(merged.size).toBe(2);
  const key = historyRollup.rollupKey('2026-07-01', 'p', 'sonnet');
  expect(merged.get(key).inputTokens).toBe(99);
});

test('mergeRollupLines: skips malformed lines without throwing', () => {
  const lines = ['not json', '', JSON.stringify({ date: '2026-07-01', projectDir: 'p', modelId: '' })];
  expect(() => historyRollup.mergeRollupLines(lines)).not.toThrow();
  expect(historyRollup.mergeRollupLines(lines).size).toBe(1);
});

test('appendRollupDays + readRollup: date-range read only returns in-range buckets', async () => {
  await historyRollup.appendRollupDays([
    { date: '2026-07-01', projectDir: 'p', modelId: 'sonnet', inputTokens: 1 },
    { date: '2026-07-05', projectDir: 'p', modelId: 'sonnet', inputTokens: 2 },
    { date: '2026-07-10', projectDir: 'p', modelId: 'sonnet', inputTokens: 3 },
  ]);
  const map = await historyRollup.readRollup('2026-07-02', '2026-07-09');
  expect(map.size).toBe(1);
  const only = Array.from(map.values())[0];
  expect(only.date).toBe('2026-07-05');
});

test('appendRollupDays: compacts (dedupes) once file exceeds threshold', async () => {
  // Force a tiny threshold isn't exposed, so just verify repeated appends of
  // the SAME key collapse to one line on disk after a compact() call.
  await historyRollup.appendRollupDays([
    { date: '2026-07-01', projectDir: 'p', modelId: 'sonnet', inputTokens: 1 },
  ]);
  await historyRollup.appendRollupDays([
    { date: '2026-07-01', projectDir: 'p', modelId: 'sonnet', inputTokens: 2 },
  ]);
  await historyRollup.compact();
  const raw = fs.readFileSync(historyRollup.ROLLUP_PATH, 'utf8');
  const nonEmptyLines = raw.split('\n').filter((l) => l.trim());
  expect(nonEmptyLines.length).toBe(1);
  expect(JSON.parse(nonEmptyLines[0]).inputTokens).toBe(2);
});

test('finalizeClosedDays: skips today, only finalizes days strictly before today', async () => {
  const today = new Date().toLocaleDateString('en-CA');
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toLocaleDateString('en-CA');
  const cwd = '/tmp/projfinalize';

  writeTranscript(cwd, 'sess-today', [
    userLine(new Date().toISOString()),
    assistantLine(new Date().toISOString(), 'claude-sonnet-5'),
  ]);
  writeTranscript(cwd, 'sess-yesterday', [
    userLine(new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()),
    assistantLine(new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(), 'claude-sonnet-5'),
  ]);

  await historyAggregator.finalizeClosedDays();

  const map = await historyRollup.readRollup('2000-01-01', today);
  const todayFinalized = historyRollup.isDateFinalized(map, today);
  const yesterdayFinalized = historyRollup.isDateFinalized(map, yesterday);
  expect(todayFinalized).toBe(false);
  expect(yesterdayFinalized).toBe(true);
});

test('deleted-transcript immunity: aggregate returns a finalized day even after its .jsonl is deleted', async () => {
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const cwd = '/tmp/projdeleted';
  const file = writeTranscript(cwd, 'sess-del', [
    userLine(yesterday.toISOString()),
    assistantLine(yesterday.toISOString(), 'claude-sonnet-5', { in: 100, out: 50 }),
  ]);

  await historyAggregator.finalizeClosedDays();
  fs.rmSync(file);

  const yStr = yesterday.toLocaleDateString('en-CA');
  const result = await historyAggregator.remote.aggregate({ fromDate: yStr, toDate: yStr });
  const row = result.rows.find((r) => r.encodedCwd === encodeCwd(cwd));
  expect(row).toBeTruthy();
  expect(row.inputTokens).toBeGreaterThanOrEqual(100);
  expect(result.rollupDays).toBeGreaterThanOrEqual(1);
});

test('backfill fold-in: aggregate() folds a rollup-missing past day into the rollup', async () => {
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const yStr = yesterday.toLocaleDateString('en-CA');
  const cwd = '/tmp/projbackfill';
  writeTranscript(cwd, 'sess-backfill', [
    userLine(yesterday.toISOString()),
    assistantLine(yesterday.toISOString(), 'claude-sonnet-5', { in: 7, out: 3 }),
  ]);

  // No finalize pass has run — the rollup has nothing for this day yet.
  const before = await historyRollup.readRollup(yStr, yStr);
  expect(before.size).toBe(0);

  const result = await historyAggregator.remote.aggregate({ fromDate: yStr, toDate: yStr });
  const row = result.rows.find((r) => r.encodedCwd === encodeCwd(cwd));
  expect(row).toBeTruthy();
  expect(row.inputTokens).toBeGreaterThanOrEqual(7);

  const after = await historyRollup.readRollup(yStr, yStr);
  expect(after.size).toBeGreaterThan(0);
});

test('finalizeClosedDays: budgetMs exceeded before any dir is walked → no dates finalized, partial=true', async () => {
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const yStr = yesterday.toLocaleDateString('en-CA');
  const cwd = '/tmp/projbudgetcap';
  writeTranscript(cwd, 'sess-budgetcap', [
    userLine(yesterday.toISOString()),
    assistantLine(yesterday.toISOString(), 'claude-sonnet-5', { in: 11, out: 4 }),
  ]);

  const result = await historyAggregator.finalizeClosedDays({ budgetMs: -1 });
  expect(result.partial).toBe(true);
  expect(result.finalizedDates).toEqual([]);

  const map = await historyRollup.readRollup('2000-01-01', yStr);
  expect(historyRollup.isDateFinalized(map, yStr)).toBe(false);
});

test('finalizeClosedDays: unbounded budgetMs finalizes normally (partial=false)', async () => {
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const yStr = yesterday.toLocaleDateString('en-CA');
  const cwd = '/tmp/projbudgetok';
  writeTranscript(cwd, 'sess-budgetok', [
    userLine(yesterday.toISOString()),
    assistantLine(yesterday.toISOString(), 'claude-sonnet-5', { in: 9, out: 2 }),
  ]);

  const result = await historyAggregator.finalizeClosedDays({ budgetMs: 60_000 });
  expect(result.partial).toBe(false);
  expect(result.finalizedDates).toContain(yStr);

  const map = await historyRollup.readRollup('2000-01-01', yStr);
  expect(historyRollup.isDateFinalized(map, yStr)).toBe(true);
});

test('finalizeClosedDays: dryRun computes finalizedDates but writes nothing', async () => {
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const yStr = yesterday.toLocaleDateString('en-CA');
  const cwd = '/tmp/projdryrun';
  writeTranscript(cwd, 'sess-dryrun', [
    userLine(yesterday.toISOString()),
    assistantLine(yesterday.toISOString(), 'claude-sonnet-5', { in: 5, out: 1 }),
  ]);

  const result = await historyAggregator.finalizeClosedDays({ dryRun: true });
  expect(result.partial).toBe(false);
  expect(result.finalizedDates).toContain(yStr);

  const map = await historyRollup.readRollup('2000-01-01', yStr);
  expect(map.size).toBe(0);
});

test('computeActiveMinutes: clamps to [0, 24h] and handles missing/invalid timestamps', () => {
  const { computeActiveMinutes } = historyAggregator;
  expect(computeActiveMinutes(null, '2026-07-01T00:10:00Z')).toBe(0);
  expect(computeActiveMinutes('2026-07-01T00:00:00Z', null)).toBe(0);
  expect(computeActiveMinutes('not-a-date', '2026-07-01T00:10:00Z')).toBe(0);
  expect(computeActiveMinutes('2026-07-01T00:00:00Z', '2026-07-01T00:10:00Z')).toBeCloseTo(10, 5);
  // Out-of-order (last before first) clamps to 0, not negative.
  expect(computeActiveMinutes('2026-07-01T00:10:00Z', '2026-07-01T00:00:00Z')).toBe(0);
  // A 30h span clamps to the 24h ceiling.
  expect(computeActiveMinutes('2026-07-01T00:00:00Z', '2026-07-02T06:00:00Z')).toBe(24 * 60);
});

test('rollup v1 lines default activeMinutes to 0 and v to 1 at read time', async () => {
  await historyRollup.appendRollupDays([
    // v1-shaped line: no activeMinutes, no v field.
    { date: '2026-07-01', projectDir: 'p', modelId: historyRollup.TOTALS_MODEL_ID, promptCount: 5 },
  ]);
  const map = await historyRollup.readRollup('2026-07-01', '2026-07-01');
  const bucket = map.get(historyRollup.rollupKey('2026-07-01', 'p', historyRollup.TOTALS_MODEL_ID));
  expect(bucket.activeMinutes).toBe(0);
});

test('refreshIntradayToday: upserts a provisional (non-finalized) line for today; a second run replaces it after compact', async () => {
  const now = new Date();
  const today = now.toLocaleDateString('en-CA');
  const cwd = '/tmp/projintraday';

  writeTranscript(cwd, 'sess-intraday', [
    userLine(new Date(now.getTime() - 5 * 60_000).toISOString()),
    assistantLine(new Date(now.getTime() - 5 * 60_000).toISOString(), 'claude-sonnet-5', { in: 10, out: 5 }),
    assistantLine(now.toISOString(), 'claude-sonnet-5', { in: 3, out: 1 }),
  ]);

  const first = await historyAggregator.refreshIntradayToday();
  expect(first.date).toBe(today);
  expect(first.projectsUpdated).toBeGreaterThanOrEqual(1);

  let map = await historyRollup.readRollup(today, today);
  expect(historyRollup.isDateFinalized(map, today)).toBe(false);
  const totalsKey = historyRollup.rollupKey(today, encodeCwd(cwd), historyRollup.TOTALS_MODEL_ID);
  const firstBucket = map.get(totalsKey);
  expect(firstBucket).toBeTruthy();
  expect(firstBucket.promptCount).toBeGreaterThanOrEqual(1);
  expect(firstBucket.activeMinutes).toBeGreaterThan(0);

  // A second refresh (e.g. 5 min later, more activity) replaces — not
  // duplicates — today's line for the same key once the file is compacted.
  await historyAggregator.refreshIntradayToday();
  await historyRollup.compact();
  const raw = fs.readFileSync(historyRollup.ROLLUP_PATH, 'utf8');
  const matchingLines = raw.split('\n').filter((l) => {
    if (!l.trim()) return false;
    const obj = JSON.parse(l);
    return obj.date === today && obj.projectDir === encodeCwd(cwd) && obj.modelId === historyRollup.TOTALS_MODEL_ID;
  });
  expect(matchingLines.length).toBe(1);
});

test('history:aggregate PARSE_BUDGET_MS truncation only affects today; finalized closed days come back complete', async () => {
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const yStr = yesterday.toLocaleDateString('en-CA');
  const cwd = '/tmp/projbudget';
  writeTranscript(cwd, 'sess-budget', [
    userLine(yesterday.toISOString()),
    assistantLine(yesterday.toISOString(), 'claude-sonnet-5', { in: 42, out: 21 }),
  ]);

  await historyAggregator.finalizeClosedDays();

  const result = await historyAggregator.remote.aggregate({ fromDate: yStr, toDate: yStr });
  expect(result.truncated).toBe(false);
  const row = result.rows.find((r) => r.encodedCwd === encodeCwd(cwd));
  expect(row).toBeTruthy();
  expect(row.inputTokens).toBeGreaterThanOrEqual(42);
});

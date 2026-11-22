/**
 * historyFinalizeResume.test.cjs — finalizeClosedDays() resumable cursor.
 * Run: timeout 300 npx vitest run src/main/__tests__/historyFinalizeResume.test.cjs
 */

'use strict';

import { test, expect, beforeEach, afterEach, vi } from 'vitest';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

let tmpHome;
let realHome;
let historyRollup;
let historyAggregator;
let cursorPath;
let clockOffset;
let statSpy;
let nowSpy;
let statted;
let statDelayMs = 0;

const DIRS = ['-a', '-b', '-c', '-d', '-e'];
const MODULES = ['../lib/historyRollup.cjs', '../historyAggregator.cjs', '../config.cjs'];
const TS = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();

function purge() {
  for (const m of MODULES) {
    try { delete require.cache[require.resolve(m)]; } catch { /* not loaded */ }
  }
}

beforeEach(() => {
  realHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'history-resume-test-'));
  process.env.HOME = tmpHome;
  purge();
  historyRollup = require('../lib/historyRollup.cjs');
  historyAggregator = require('../historyAggregator.cjs');
  cursorPath = path.join(tmpHome, 'cursor.json');
  for (const d of DIRS) {
    const dir = path.join(tmpHome, '.claude', 'projects', d);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 's.jsonl'), [
      JSON.stringify({ role: 'user', ts: TS }),
      JSON.stringify({ ts: TS, message: { role: 'assistant', model: 'claude-sonnet-5', usage: { input_tokens: 10, output_tokens: 5 } } }),
    ].join('\n') + '\n');
  }
  // Fake clock: every transcript stat costs 100 ms, so budgetMs=150 walks 2 dirs per call.
  clockOffset = 0;
  statDelayMs = 0;
  statted = [];
  const base = Date.now();
  nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => base + clockOffset);
  const realStat = fsp.stat.bind(fsp);
  statSpy = vi.spyOn(fsp, 'stat').mockImplementation(async (p, ...rest) => {
    if (String(p).endsWith('.jsonl') && String(p).includes(path.join('.claude', 'projects'))) {
      if (statDelayMs) await new Promise((r) => setTimeout(r, statDelayMs));
      clockOffset += 100;
      statted.push(path.basename(path.dirname(String(p))));
    }
    return realStat(p, ...rest);
  });
});

afterEach(() => {
  statSpy.mockRestore();
  nowSpy.mockRestore();
  process.env.HOME = realHome;
  purge();
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

const readCursor = () => JSON.parse(fs.readFileSync(cursorPath, 'utf8'));
async function finalizedCount() {
  const map = await historyRollup.readRollup('2000-01-01', '2999-01-01');
  return [...map.values()].filter((b) => b.projectDir === historyRollup.FINALIZED_PROJECT_ID).length;
}

test('resumes after lastDir, never re-parses a dir, finalizes only on completion, then resets', async () => {
  let r = await historyAggregator.finalizeClosedDays({ budgetMs: 150, cursorPath });
  expect(r.partial).toBe(true);
  expect(r.finalizedDates).toEqual([]);
  expect(readCursor().lastDir).toBe('-b');
  expect(await finalizedCount()).toBe(0);

  r = await historyAggregator.finalizeClosedDays({ budgetMs: 150, cursorPath });
  expect(r.partial).toBe(true);
  expect(readCursor().lastDir).toBe('-d');
  expect(await finalizedCount()).toBe(0);

  r = await historyAggregator.finalizeClosedDays({ budgetMs: 150, cursorPath });
  expect(r.partial).toBe(false);
  expect(r.finalizedDates.length).toBe(1);
  expect(await finalizedCount()).toBe(1);
  expect(fs.existsSync(cursorPath)).toBe(false);

  expect(statted).toEqual(DIRS); // each dir exactly once across the cycle
});

test('dryRun never writes the cursor', async () => {
  await historyAggregator.finalizeClosedDays({ budgetMs: 150, dryRun: true, cursorPath });
  expect(fs.existsSync(cursorPath)).toBe(false);
});

test('missing or corrupt cursor starts a fresh cycle', async () => {
  fs.writeFileSync(cursorPath, '{not json');
  await historyAggregator.finalizeClosedDays({ budgetMs: 150, cursorPath });
  expect(statted).toEqual(['-a', '-b']);
  expect(readCursor().lastDir).toBe('-b');
});

test('budget is independent of real elapsed time', async () => {
  statDelayMs = 80;
  await historyAggregator.finalizeClosedDays({ budgetMs: 150, cursorPath });
  expect(statted).toEqual(['-a', '-b']);
  expect(readCursor().lastDir).toBe('-b');
});

test('a finalize pass over a day with transcripts writes a current-version (v4) marker', async () => {
  const r = await historyAggregator.finalizeClosedDays({ budgetMs: Infinity, cursorPath });
  expect(r.partial).toBe(false);
  expect(r.finalizedDates.length).toBe(1);
  const map = await historyRollup.readRollup('2000-01-01', '2999-01-01');
  const marker = map.get(historyRollup.rollupKey(r.finalizedDates[0], historyRollup.FINALIZED_PROJECT_ID, historyRollup.FINALIZED_MODEL_ID));
  expect(marker.v).toBe(4);
  expect(historyRollup.legacyFinalizedDates(map)).toEqual([]);
});

// ── skip folders unchanged since the last completed pass ─────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;
const projFile = (d) => path.join(tmpHome, '.claude', 'projects', d, 's.jsonl');
function writeTranscript(d, ts, inputTokens, name = 's.jsonl') {
  fs.writeFileSync(path.join(tmpHome, '.claude', 'projects', d, name), [
    JSON.stringify({ role: 'user', ts }),
    JSON.stringify({ ts, message: { role: 'assistant', model: 'claude-sonnet-5', usage: { input_tokens: inputTokens, output_tokens: 5 } } }),
  ].join('\n') + '\n');
}
// Transcripts are append-only; the parse cache tail-reads a grown file.
function appendUsage(d, ts, inputTokens) {
  fs.appendFileSync(projFile(d), JSON.stringify({ ts, message: { role: 'assistant', model: 'claude-sonnet-5', usage: { input_tokens: inputTokens, output_tokens: 5 } } }) + '\n');
}
function setMtime(file, ms) { fs.utimesSync(file, ms / 1000, ms / 1000); }
function localMidnight(ms) { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); }
async function inputTokens(date, dir) {
  const map = await historyRollup.readRollup(date, date);
  let sum = 0;
  for (const b of map.values()) {
    if (b.projectDir !== dir || b.modelId === historyRollup.TOTALS_MODEL_ID) continue;
    sum += b.inputTokens || 0;
  }
  return sum;
}
const DATE = new Date(TS).toLocaleDateString('en-CA');

test('a finalized marker carries cycleStartedAt; the reader returns the newest at the current version', async () => {
  const start = Date.now();
  await historyAggregator.finalizeClosedDays({ cursorPath });
  const map = await historyRollup.readRollup('2000-01-01', '2999-01-01');
  const marker = map.get(historyRollup.rollupKey(DATE, historyRollup.FINALIZED_PROJECT_ID, historyRollup.FINALIZED_MODEL_ID));
  expect(marker.cycleStartedAt).toBe(start);
  expect(await historyRollup.readNewestFinalizedCycleStart()).toBe(start);
});

test('a resumed cycle stamps the cycle start, not the completing call time', async () => {
  const start = Date.now();
  await historyAggregator.finalizeClosedDays({ budgetMs: 150, cursorPath });
  await historyAggregator.finalizeClosedDays({ budgetMs: 150, cursorPath });
  const r = await historyAggregator.finalizeClosedDays({ budgetMs: 150, cursorPath });
  expect(r.partial).toBe(false);
  expect(await historyRollup.readNewestFinalizedCycleStart()).toBe(start);
});

test('second pass leaves a folder unchanged since the threshold alone', async () => {
  await historyAggregator.finalizeClosedDays({ cursorPath });
  expect(await inputTokens(DATE, '-a')).toBe(10);
  const threshold = localMidnight(await historyRollup.readNewestFinalizedCycleStart());
  writeTranscript('-a', TS, 999);
  setMtime(projFile('-a'), threshold - 60 * 60 * 1000);
  const before = (await historyRollup.readRollup(DATE, DATE)).get(historyRollup.rollupKey(DATE, historyRollup.FINALIZED_PROJECT_ID, historyRollup.FINALIZED_MODEL_ID));
  await historyAggregator.finalizeClosedDays({ cursorPath });
  expect(await inputTokens(DATE, '-a')).toBe(10);
  expect(await inputTokens(DATE, '-b')).toBe(10);
  // Day still found in read folders, so its marker is refreshed.
  const after = (await historyRollup.readRollup(DATE, DATE)).get(historyRollup.rollupKey(DATE, historyRollup.FINALIZED_PROJECT_ID, historyRollup.FINALIZED_MODEL_ID));
  expect(after.finalizedAt).toBeGreaterThanOrEqual(before.finalizedAt);
});

test('markers of days found only in skipped folders are not rewritten', async () => {
  const OLD_TS = new Date(Date.now() - 5 * DAY_MS).toISOString();
  const OLD_DATE = new Date(OLD_TS).toLocaleDateString('en-CA');
  writeTranscript('-a', OLD_TS, 7, 'old.jsonl');
  await historyAggregator.finalizeClosedDays({ cursorPath });
  const threshold = localMidnight(await historyRollup.readNewestFinalizedCycleStart());
  for (const d of DIRS) setMtime(projFile(d), threshold - 1000);
  setMtime(path.join(tmpHome, '.claude', 'projects', '-a', 'old.jsonl'), threshold - 1000);
  const key = historyRollup.rollupKey(OLD_DATE, historyRollup.FINALIZED_PROJECT_ID, historyRollup.FINALIZED_MODEL_ID);
  const before = (await historyRollup.readRollup(OLD_DATE, OLD_DATE)).get(key);
  clockOffset += 10_000;
  const r = await historyAggregator.finalizeClosedDays({ cursorPath });
  expect(r.finalizedDates).toEqual([]);
  const after = (await historyRollup.readRollup(OLD_DATE, OLD_DATE)).get(key);
  expect(after).toEqual(before);
  expect(await inputTokens(OLD_DATE, '-a')).toBe(7);
});

test('a transcript modified after the threshold is recounted', async () => {
  await historyAggregator.finalizeClosedDays({ cursorPath });
  appendUsage('-a', TS, 989);
  await historyAggregator.finalizeClosedDays({ cursorPath });
  expect(await inputTokens(DATE, '-a')).toBe(999);
});

test('a transcript modified on the last pass day, before that pass ran, is recounted', async () => {
  await historyAggregator.finalizeClosedDays({ cursorPath });
  const passStart = await historyRollup.readNewestFinalizedCycleStart();
  const threshold = localMidnight(passStart);
  appendUsage('-a', TS, 989);
  setMtime(projFile('-a'), threshold + Math.floor((passStart - threshold) / 2));
  await historyAggregator.finalizeClosedDays({ cursorPath });
  expect(await inputTokens(DATE, '-a')).toBe(999);
});

test('after a version change every folder is read again', async () => {
  await historyAggregator.finalizeClosedDays({ cursorPath });
  const rollupFile = historyRollup.historyRollupPath();
  const downgraded = fs.readFileSync(rollupFile, 'utf8').split('\n').map((l) => {
    if (!l.trim()) return l;
    const o = JSON.parse(l);
    if (o.modelId === historyRollup.FINALIZED_MODEL_ID) o.v = historyRollup.ROLLUP_VERSION - 1;
    return JSON.stringify(o);
  }).join('\n');
  fs.writeFileSync(rollupFile, downgraded);
  expect(await historyRollup.readNewestFinalizedCycleStart()).toBe(null);
  appendUsage('-a', TS, 989);
  setMtime(projFile('-a'), Date.now() - 10 * DAY_MS);
  await historyAggregator.finalizeClosedDays({ cursorPath });
  expect(await inputTokens(DATE, '-a')).toBe(999);
});

test('a day that closed since the last pass gets a marker and totals from all its folders', async () => {
  nowSpy.mockRestore();
  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    const dayD = new Date(2026, 5, 10, 12, 0, 0).getTime(); // D at local noon
    const prevTs = new Date(dayD - DAY_MS).toISOString();
    for (const d of DIRS) {
      writeTranscript(d, prevTs, 10);
      setMtime(projFile(d), dayD - DAY_MS + 60_000);
    }
    vi.setSystemTime(dayD);
    await historyAggregator.finalizeClosedDays({ cursorPath });
    const dDate = new Date(dayD).toLocaleDateString('en-CA');
    // More activity on D, after the pass, in two folders.
    const laterTs = new Date(dayD + 60 * 60 * 1000).toISOString();
    for (const d of ['-b', '-d']) {
      const f = path.join(tmpHome, '.claude', 'projects', d, 'later.jsonl');
      writeTranscript(d, laterTs, d === '-b' ? 3 : 4, 'later.jsonl');
      setMtime(f, dayD + 2 * 60 * 60 * 1000);
    }
    vi.setSystemTime(dayD + DAY_MS - 3 * 60 * 60 * 1000); // D+1, 09:00
    const r = await historyAggregator.finalizeClosedDays({ cursorPath });
    expect(r.finalizedDates).toContain(dDate);
    const map = await historyRollup.readRollup(dDate, dDate);
    expect(historyRollup.isDateFinalized(map, dDate)).toBe(true);
    expect(await inputTokens(dDate, '-b')).toBe(3);
    expect(await inputTokens(dDate, '-d')).toBe(4);
  } finally {
    vi.useRealTimers();
  }
});

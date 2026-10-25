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

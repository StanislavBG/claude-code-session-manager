/**
 * historyAggregatorTaskSkip.test.cjs — a persisted Task's claude transcript
 * (<sessionId>.jsonl under ~/.claude/projects) must add nothing to History:
 * the sm-task ledger row already counts it. Every rollup-feeding walk
 * (aggregate, computeIntradayBuckets, finalizeClosedDays) skips it; the
 * Task-id readers are injected so no real ledger is read.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/historyAggregatorTaskSkip.test.cjs
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

const CWD = '/tmp/proj-task-skip';
const ENCODED = CWD.replace(/\//g, '-');
const TASK_SID = '11111111-2222-3333-4444-555555555555';
const HUMAN_SID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

const MODULES_TO_RELOAD = ['../lib/historyRollup.cjs', '../historyAggregator.cjs', '../config.cjs'];
function purgeRequireCache() {
  for (const m of MODULES_TO_RELOAD) {
    try { delete require.cache[require.resolve(m)]; } catch { /* not loaded */ }
  }
}

function writeTranscript(sessionId, when, tokens) {
  const dir = path.join(tmpHome, '.claude', 'projects', ENCODED);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.jsonl`);
  const ts = when.toISOString();
  const lines = [
    { role: 'user', ts },
    { ts, message: { role: 'assistant', model: 'claude-sonnet-5', usage: { input_tokens: tokens.in, output_tokens: tokens.out } } },
  ];
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');
  fs.utimesSync(file, when, when);
}

function injectTaskIds(ids) {
  historyAggregator.setTaskSessionReadersForTests({
    listTaskProjects: () => [{ cwd: CWD, enabled: true, changedAt: 0 }],
    listPersistedSessionIds: async (cwd) => (cwd === CWD ? new Set(ids) : new Set()),
  });
}

beforeEach(() => {
  realHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'history-taskskip-test-'));
  process.env.HOME = tmpHome;
  purgeRequireCache();
  historyRollup = require('../lib/historyRollup.cjs');
  historyAggregator = require('../historyAggregator.cjs');
  historyAggregator.resetIntradayRegistryForTests();
});

afterEach(() => {
  historyAggregator.setTaskSessionReadersForTests(null);
  process.env.HOME = realHome;
  purgeRequireCache();
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

function todayNoon() { const d = new Date(); d.setHours(12, 0, 0, 0); return d.getTime() > Date.now() ? new Date(Date.now() - 1000) : d; }
function yesterdayNoon() { const d = new Date(); d.setDate(d.getDate() - 1); d.setHours(12, 0, 0, 0); return d; }

test('aggregate: the persisted Task transcript adds no tokens, prompts or sessions', async () => {
  writeTranscript(HUMAN_SID, todayNoon(), { in: 10, out: 5 });
  writeTranscript(TASK_SID, todayNoon(), { in: 1000, out: 500 });
  injectTaskIds([TASK_SID]);
  const today = historyAggregator.localDate(new Date());
  const { rows } = await historyAggregator.remote.aggregate({ fromDate: today, toDate: today });
  const row = rows.find((r) => r.encodedCwd === ENCODED);
  expect(row).toBeTruthy();
  expect(row.inputTokens).toBe(10);
  expect(row.outputTokens).toBe(5);
  expect(row.promptCount).toBe(1);
  expect(row.sessionCount).toBe(1);
});

test('aggregate: with no Task projects both transcripts count (unchanged output)', async () => {
  writeTranscript(HUMAN_SID, todayNoon(), { in: 10, out: 5 });
  writeTranscript(TASK_SID, todayNoon(), { in: 1000, out: 500 });
  historyAggregator.setTaskSessionReadersForTests({ listTaskProjects: () => [], listPersistedSessionIds: async () => new Set() });
  const today = historyAggregator.localDate(new Date());
  const { rows } = await historyAggregator.remote.aggregate({ fromDate: today, toDate: today });
  const row = rows.find((r) => r.encodedCwd === ENCODED);
  expect(row.inputTokens).toBe(1010);
  expect(row.sessionCount).toBe(2);
});

test('a failing ledger read skips that project only and never fails the pass', async () => {
  writeTranscript(HUMAN_SID, todayNoon(), { in: 10, out: 5 });
  writeTranscript(TASK_SID, todayNoon(), { in: 1000, out: 500 });
  historyAggregator.setTaskSessionReadersForTests({
    listTaskProjects: () => [{ cwd: '/broken' }, { cwd: CWD }],
    listPersistedSessionIds: async (cwd) => { if (cwd === '/broken') throw new Error('EACCES'); return new Set([TASK_SID]); },
  });
  expect(await historyAggregator.taskSessionIdSet()).toEqual(new Set([TASK_SID]));
  const today = historyAggregator.localDate(new Date());
  const { rows } = await historyAggregator.remote.aggregate({ fromDate: today, toDate: today });
  expect(rows.find((r) => r.encodedCwd === ENCODED).inputTokens).toBe(10);

  historyAggregator.setTaskSessionReadersForTests({
    listTaskProjects: () => { throw new Error('boom'); },
    listPersistedSessionIds: async () => new Set(),
  });
  expect((await historyAggregator.taskSessionIdSet()).size).toBe(0);
});

test('computeIntradayBuckets: today bucket comes from the non-Task transcript only', async () => {
  writeTranscript(HUMAN_SID, todayNoon(), { in: 10, out: 5 });
  writeTranscript(TASK_SID, todayNoon(), { in: 1000, out: 500 });
  injectTaskIds([TASK_SID]);
  const { today, buckets } = await historyAggregator.computeIntradayBuckets();
  const b = buckets.get(`${today}|${ENCODED}`);
  expect(b).toBeTruthy();
  expect(b.inputTokens).toBe(10);
  expect(b.sessionCount).toBe(1);
});

test('finalizeClosedDays: the closed-day rollup excludes the Task transcript', async () => {
  writeTranscript(HUMAN_SID, yesterdayNoon(), { in: 10, out: 5 });
  writeTranscript(TASK_SID, yesterdayNoon(), { in: 1000, out: 500 });
  injectTaskIds([TASK_SID]);
  const cursorPath = path.join(tmpHome, 'cursor.json');
  const { finalizedDates } = await historyAggregator.finalizeClosedDays({ cursorPath });
  const yesterday = historyAggregator.localDate(yesterdayNoon());
  expect(finalizedDates).toContain(yesterday);
  const map = await historyRollup.readRollup(yesterday, yesterday);
  const data = [...map.values()].filter((b) => b.projectDir === ENCODED);
  expect(data.length).toBeGreaterThan(0);
  expect(data.reduce((s, b) => s + b.inputTokens, 0)).toBe(10);
});

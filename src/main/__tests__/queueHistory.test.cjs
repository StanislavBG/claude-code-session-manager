/**
 * queueHistory.test.cjs — unit tests for src/main/lib/queueHistory.cjs and
 * scheduler.cjs's selectHistoryJobs merge.
 *
 * Run: timeout 300 npx vitest run src/main/__tests__/queueHistory.test.cjs
 */

'use strict';

import { test, expect, beforeEach, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const RETENTION_MS = 7 * 24 * 60 * 60_000;
const NOW = Date.parse('2026-07-24T12:00:00.000Z');

function fresh(overrides = {}) {
  return {
    slug: '01-fresh',
    status: 'completed',
    runId: 'run-1',
    finishedAt: new Date(NOW - 1 * 60 * 60_000).toISOString(), // 1h ago
    ...overrides,
  };
}

function old(overrides = {}) {
  return {
    slug: '02-old',
    status: 'completed',
    runId: 'run-2',
    finishedAt: new Date(NOW - 10 * 24 * 60 * 60_000).toISOString(), // 10d ago
    ...overrides,
  };
}

let queueHistory;

beforeEach(() => {
  // Fresh require per test so HISTORY_PATH's target file starts clean.
  delete require.cache[require.resolve('../lib/queueHistory.cjs')];
  queueHistory = require('../lib/queueHistory.cjs');
  try { fs.unlinkSync(queueHistory.HISTORY_PATH); } catch { /* ok if absent */ }
});

afterEach(() => {
  try { fs.unlinkSync(queueHistory.HISTORY_PATH); } catch { /* ok if absent */ }
});

// ---------- partitionJobs ----------

test('partitionJobs: fresh completed job stays hot', () => {
  const { hot, toArchive } = queueHistory.partitionJobs([fresh()], NOW);
  expect(hot.map((j) => j.slug)).toEqual(['01-fresh']);
  expect(toArchive).toEqual([]);
});

test('partitionJobs: old completed job archives', () => {
  const { hot, toArchive } = queueHistory.partitionJobs([old()], NOW);
  expect(hot).toEqual([]);
  expect(toArchive.map((j) => j.slug)).toEqual(['02-old']);
});

test('partitionJobs: old failed job archives', () => {
  const j = old({ slug: '03-old-failed', status: 'failed', runId: 'run-3' });
  const { hot, toArchive } = queueHistory.partitionJobs([j], NOW);
  expect(hot).toEqual([]);
  expect(toArchive.map((x) => x.slug)).toEqual(['03-old-failed']);
});

test('partitionJobs: running and pending jobs never archive, regardless of age', () => {
  const running = old({ slug: '04-running', status: 'running', runId: 'run-4', finishedAt: null });
  const pending = old({ slug: '05-pending', status: 'pending', runId: null, finishedAt: null });
  const { hot, toArchive } = queueHistory.partitionJobs([running, pending], NOW);
  expect(toArchive).toEqual([]);
  expect(hot.map((j) => j.slug).sort()).toEqual(['04-running', '05-pending']);
});

test('partitionJobs: needs_review jobs never archive', () => {
  const j = old({ slug: '06-review', status: 'needs_review', runId: 'run-6' });
  const { hot, toArchive } = queueHistory.partitionJobs([j], NOW);
  expect(toArchive).toEqual([]);
  expect(hot.map((x) => x.slug)).toEqual(['06-review']);
});

test('partitionJobs: job with no/invalid finishedAt stays hot even if old status', () => {
  const j = { slug: '07-nofinish', status: 'completed', runId: 'run-7', finishedAt: null };
  const { hot, toArchive } = queueHistory.partitionJobs([j], NOW);
  expect(toArchive).toEqual([]);
  expect(hot.map((x) => x.slug)).toEqual(['07-nofinish']);
});

test('partitionJobs: fix-plan linkage keeps an old original hot while its fix is pending', () => {
  const original = old({ slug: '08-thing', status: 'failed', runId: 'run-8' });
  const fixPlan = { slug: '08-fix-thing', status: 'pending', runId: null, finishedAt: null };
  const { hot, toArchive } = queueHistory.partitionJobs([original, fixPlan], NOW);
  expect(toArchive).toEqual([]);
  expect(hot.map((x) => x.slug).sort()).toEqual(['08-fix-thing', '08-thing']);
});

test('partitionJobs: fix-plan linkage keeps an old original hot while its fix is running', () => {
  const original = old({ slug: '09-thing', status: 'failed', runId: 'run-9' });
  const fixPlan = { slug: '09-fix-thing', status: 'running', runId: 'run-9b', finishedAt: null };
  const { hot, toArchive } = queueHistory.partitionJobs([original, fixPlan], NOW);
  expect(toArchive).toEqual([]);
  expect(hot.map((x) => x.slug).sort()).toEqual(['09-fix-thing', '09-thing']);
});

test('partitionJobs: an old original with a COMPLETED fix-plan is free to archive (no longer protected)', () => {
  const original = old({ slug: '10-thing', status: 'completed', runId: 'run-10' });
  const fixPlan = old({ slug: '10-fix-thing', status: 'completed', runId: 'run-10b' });
  const { hot, toArchive } = queueHistory.partitionJobs([original, fixPlan], NOW);
  expect(hot).toEqual([]);
  expect(toArchive.map((x) => x.slug).sort()).toEqual(['10-fix-thing', '10-thing']);
});

test('partitionJobs: respects opts.retentionMs override', () => {
  const j = { slug: '11-recent', status: 'completed', runId: 'run-11', finishedAt: new Date(NOW - 2 * 60 * 60_000).toISOString() };
  const { toArchive } = queueHistory.partitionJobs([j], NOW, { retentionMs: 60 * 60_000 }); // 1h retention
  expect(toArchive.map((x) => x.slug)).toEqual(['11-recent']);
});

// ---------- appendHistory / readHistory ----------

test('appendHistory writes entries, readHistory reads them back newest-first', async () => {
  const a = old({ slug: 'a', runId: 'ra', finishedAt: new Date(NOW - 3 * 60 * 60_000).toISOString() });
  const b = old({ slug: 'b', runId: 'rb', finishedAt: new Date(NOW - 1 * 60 * 60_000).toISOString() });
  await queueHistory.appendHistory([a, b]);
  const read = await queueHistory.readHistory({ limit: 10 });
  // appended in file order a,b; readHistory reverses file order to newest-appended-first
  expect(read.map((j) => j.slug)).toEqual(['b', 'a']);
});

test('appendHistory dedupes by slug+runId against what is already on disk', async () => {
  const a = old({ slug: 'dup', runId: 'r1' });
  const r1 = await queueHistory.appendHistory([a]);
  expect(r1.appended).toBe(1);
  const r2 = await queueHistory.appendHistory([a]); // replay of the same batch (crash-recovery scenario)
  expect(r2.appended).toBe(0);
  const read = await queueHistory.readHistory({ limit: 10 });
  expect(read.length).toBe(1);
});

test('readHistory respects limit and returns [] when file is absent', async () => {
  const empty = await queueHistory.readHistory({ limit: 5 });
  expect(empty).toEqual([]);

  const entries = Array.from({ length: 8 }, (_, i) => old({ slug: `s${i}`, runId: `r${i}`, finishedAt: new Date(NOW - i * 60_000).toISOString() }));
  await queueHistory.appendHistory(entries);
  const read = await queueHistory.readHistory({ limit: 3 });
  expect(read.length).toBe(3);
  // newest-appended-first == last 3 entries reversed
  expect(read.map((j) => j.slug)).toEqual(['s7', 's6', 's5']);
});

test('readHistory tail-reads correctly when the file is larger than one chunk', async () => {
  // Force many small appends so the file exceeds the initial 64KB read chunk.
  const bigEntries = Array.from({ length: 2000 }, (_, i) => ({
    slug: `bulk-${i}`,
    status: 'completed',
    runId: `bulk-run-${i}`,
    finishedAt: new Date(NOW - i * 1000).toISOString(),
    bodyPreview: 'x'.repeat(80),
  }));
  await queueHistory.appendHistory(bigEntries);
  const read = await queueHistory.readHistory({ limit: 5 });
  // appended in ascending index order; readHistory reverses to newest-appended-first
  expect(read.map((j) => j.slug)).toEqual(['bulk-1999', 'bulk-1998', 'bulk-1997', 'bulk-1996', 'bulk-1995']);
});

// ---------- selectHistoryJobs merge (scheduler.cjs) ----------

test('selectHistoryJobs merges hot jobs[] and history tail, newest-first, deduped', () => {
  const { selectHistoryJobs } = require('../scheduler.cjs');
  const hotJob = fresh({ slug: 'hot-1', runId: 'rh1' });
  const historyEntry = old({ slug: 'hist-1', runId: 'rhist1' });
  const merged = selectHistoryJobs([hotJob], 10, [historyEntry]);
  expect(merged.map((j) => j.slug)).toEqual(['hot-1', 'hist-1']); // hot is newer
});

test('selectHistoryJobs: jobs[] entry wins over a duplicate history entry with the same slug+runId', () => {
  const { selectHistoryJobs } = require('../scheduler.cjs');
  const hotCopy = fresh({ slug: 'dup', runId: 'rd', bodyPreview: 'from-hot' });
  const historyCopy = fresh({ slug: 'dup', runId: 'rd', bodyPreview: 'from-history' });
  const merged = selectHistoryJobs([hotCopy], 10, [historyCopy]);
  expect(merged.length).toBe(1);
  expect(merged[0].bodyPreview).toBe('from-hot');
});

test('selectHistoryJobs: default historyEntries=[] preserves old call shape', () => {
  const { selectHistoryJobs } = require('../scheduler.cjs');
  const merged = selectHistoryJobs([fresh()], 10);
  expect(merged.map((j) => j.slug)).toEqual(['01-fresh']);
});

// ---------- historyTerminalBySlug ----------
//
// Guards against scheduler.cjs's reconcile() resurrecting an already-
// archived-to-history job as a fresh 'pending' entry (and the scheduler
// then genuinely re-executing an already-completed PRD) just because its
// job row already left jobs[]. reconcile() consults this map before
// treating an unmatched on-disk PRD slug as brand-new.

test('historyTerminalBySlug: returns status + finishedAt for every archived slug', async () => {
  const a = old({ slug: 'term-completed', status: 'completed', runId: 'rc' });
  const b = old({ slug: 'term-failed', status: 'failed', runId: 'rf' });
  await queueHistory.appendHistory([a, b]);

  const map = await queueHistory.historyTerminalBySlug();
  expect(map.get('term-completed')).toEqual({ status: 'completed', finishedAt: a.finishedAt, landedCommit: null });
  expect(map.get('term-failed')).toEqual({ status: 'failed', finishedAt: b.finishedAt, landedCommit: null });
  expect(map.has('never-archived-slug')).toBe(false);
});

test('historyTerminalBySlug: returns an empty map when history.jsonl is absent', async () => {
  const map = await queueHistory.historyTerminalBySlug();
  expect(map.size).toBe(0);
});

test('historyTerminalBySlug: cache invalidates after a new appendHistory call (mtime changes)', async () => {
  const a = old({ slug: 'cache-1', runId: 'rca' });
  await queueHistory.appendHistory([a]);
  const first = await queueHistory.historyTerminalBySlug();
  expect(first.has('cache-1')).toBe(true);
  expect(first.has('cache-2')).toBe(false);

  const b = old({ slug: 'cache-2', runId: 'rcb' });
  await queueHistory.appendHistory([b]);
  const second = await queueHistory.historyTerminalBySlug();
  expect(second.has('cache-1')).toBe(true);
  expect(second.has('cache-2')).toBe(true);
});

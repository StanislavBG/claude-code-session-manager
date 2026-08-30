/**
 * scheduler-clear-queue-history.test.cjs — schedule:clear-queue must never
 * drop a job row with zero audit trail. Before this PRD, the handler did
 * `s.jobs = s.jobs.filter(...)` straight over every non-running victim with
 * no history.jsonl write at all — a queue row (e.g. the 2026-08-30 sigma
 * `788-pr-sweep-final-gate` incident) could vanish leaving no trace anywhere.
 *
 * Exercises `applyClearQueueVictims` (the core mutation extracted from the
 * `schedule:clear-queue` IPC handler so it's testable without ipcMain/
 * electron) directly against a synthetic state, then feeds its output
 * through the REAL `queueHistory.appendHistory`. Job fixtures carry a real
 * absolute `cwd` under a per-test mkdtemp dir (never the live operations
 * root) because appendHistory routes each entry to its OWN project's
 * `<cwd>/session-manager-operations/scheduler/state/history.jsonl` shard
 * whenever the entry has a `cwd` — SM_HISTORY_PATH_OVERRIDE only affects
 * cwd-less entries, and the AC here requires every entry to carry a cwd.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/scheduler-clear-queue-history.test.cjs
 */

'use strict';

import { test, expect, beforeEach, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const queueHistory = require('../lib/queueHistory.cjs');
const { projectHistoryPath } = require('../lib/queueStore.cjs');
const scheduler = require('../scheduler.cjs');

let tmpCwd;

beforeEach(() => {
  tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-clear-queue-history-'));
});

afterEach(() => {
  fs.rmSync(tmpCwd, { recursive: true, force: true });
});

function pendingJob(slug, overrides = {}) {
  return { slug, cwd: tmpCwd, status: 'pending', runId: null, finishedAt: null, ...overrides };
}

function historyPath() {
  return projectHistoryPath(tmpCwd);
}

function readHistoryRows() {
  const text = fs.readFileSync(historyPath(), 'utf8').trim();
  return text ? text.split('\n').map((l) => JSON.parse(l)) : [];
}

test('applyClearQueueVictims transitions N pending jobs to skipped, drops them from state.jobs, and appendHistory writes N rows with source clear-queue', async () => {
  const jobs = [pendingJob('101-a'), pendingJob('102-b'), pendingJob('103-c')];
  const running = { slug: '104-running', cwd: tmpCwd, status: 'running', runId: 'run-104', finishedAt: null };
  const state = { jobs: [...jobs, running] };
  const victimSlugs = new Set(jobs.map((j) => j.slug));
  const archiveNoteBySlug = new Map(jobs.map((j) => [j.slug, 'PRD file archived to /fake/archive/dir']));

  const historyEntries = scheduler.applyClearQueueVictims(state, victimSlugs, archiveNoteBySlug, '/fake/archive/dir');

  // Running job is untouched, exempt from clear-queue, and got no history row.
  expect(state.jobs.map((j) => j.slug)).toEqual(['104-running']);
  expect(historyEntries.map((e) => e.slug).sort()).toEqual(['101-a', '102-b', '103-c']);
  for (const entry of historyEntries) {
    expect(entry.status).toBe('skipped'); // NEVER 'completed' — a manually cleared job did not ship
    expect(entry.cwd).toBe(tmpCwd);
    expect(entry.finishedAt).toBeTruthy();
    const last = entry.statusHistory[entry.statusHistory.length - 1];
    expect(last.source).toBe('clear-queue');
    expect(last.reason).toContain('/fake/archive/dir');
  }

  const { appended } = await queueHistory.appendHistory(historyEntries);
  expect(appended).toBe(3);
  const onDisk = readHistoryRows();
  expect(onDisk.length).toBe(3);
  expect(onDisk.every((e) => e.status === 'skipped')).toBe(true);
  expect(onDisk.every((e) => e.statusHistory.at(-1).source === 'clear-queue')).toBe(true);

  // queue.json (state.jobs, what writeQueue serializes) no longer lists them.
  expect(state.jobs.some((j) => victimSlugs.has(j.slug))).toBe(false);
});

test('running jobs are exempt from clear-queue and never appear in the returned history entries', () => {
  const running = { slug: '201-running', cwd: tmpCwd, status: 'running', runId: 'run-201', finishedAt: null };
  const state = { jobs: [running] };
  const victimSlugs = new Set(); // schedule:clear-queue never includes running jobs as victims

  const historyEntries = scheduler.applyClearQueueVictims(state, victimSlugs, new Map(), '/fake/archive/dir');

  expect(historyEntries).toEqual([]);
  expect(state.jobs).toEqual([running]);
});

test('a victim already terminal (completed) keeps its real status, not skipped, but still gets a clear-queue history row', () => {
  const completed = { slug: '301-done', cwd: tmpCwd, status: 'completed', runId: 'run-301', finishedAt: '2026-08-29T00:00:00.000Z', statusHistory: [] };
  const state = { jobs: [completed] };
  const victimSlugs = new Set(['301-done']);

  const historyEntries = scheduler.applyClearQueueVictims(state, victimSlugs, new Map(), '/fake/archive/dir');

  expect(state.jobs).toEqual([]);
  expect(historyEntries.length).toBe(1);
  expect(historyEntries[0].status).toBe('completed'); // real outcome preserved, not overwritten to skipped
  const last = historyEntries[0].statusHistory.at(-1);
  expect(last.source).toBe('clear-queue');
  expect(last.from).toBe('completed');
  expect(last.to).toBe('completed');
});

test('appendHistory dedupe: clearing an already-cleared queue twice does not double-write rows', async () => {
  const jobs = [pendingJob('401-x'), pendingJob('402-y')];
  const state = { jobs: [...jobs] };
  const victimSlugs = new Set(jobs.map((j) => j.slug));

  const historyEntries = scheduler.applyClearQueueVictims(state, victimSlugs, new Map(), '/fake/archive/dir');
  expect(state.jobs).toEqual([]);

  const r1 = await queueHistory.appendHistory(historyEntries);
  expect(r1.appended).toBe(2);

  // A crash-replay of the SAME batch through appendHistory (the dedupe
  // queueHistory itself guards against) must not double-write — this is
  // what protects a second clear-queue pass, or a retry after a crash
  // between the mutate() and appendHistory calls, from duplicating rows.
  const r2 = await queueHistory.appendHistory(historyEntries);
  expect(r2.appended).toBe(0);

  const onDisk = readHistoryRows();
  expect(onDisk.length).toBe(2);
});

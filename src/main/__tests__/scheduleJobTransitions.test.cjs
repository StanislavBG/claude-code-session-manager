/**
 * scheduleJobTransitions.test.cjs — unit tests for transitionJob(), the sole
 * chokepoint for a ScheduleJob's `status` field (scheduleJobTransitions.cjs).
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/scheduleJobTransitions.test.cjs
 */
'use strict';

import { test, expect, vi, beforeEach, afterEach } from 'vitest';
const fs = require('node:fs');
const crypto = require('node:crypto');
const {
  transitionJob,
  LEGAL_TRANSITIONS,
  STATUS_HISTORY_CAP,
  getRefusedTransitionCount,
  _resetRefusedTransitionCountForTests,
} = require('../lib/scheduleJobTransitions.cjs');
const auditLog = require('../lib/auditLog.cjs');
const queueHistory = require('../lib/queueHistory.cjs');

function uniqueSlug(label) {
  return `test-${label}-${crypto.randomUUID().slice(0, 8)}`;
}

function readAuditRecordsForSlug(slug) {
  if (!fs.existsSync(auditLog.auditLogPath())) return [];
  return fs.readFileSync(auditLog.auditLogPath(), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter((record) => record && record.slug === slug);
}

test('a legal transition mutates the job, records statusHistory, and audits', () => {
  const slug = uniqueSlug('legal');
  const job = { slug, cwd: '/tmp/proj', status: 'pending' };

  const ok = transitionJob(job, 'running', { reason: 'dispatched', source: 'test' });

  expect(ok).toBe(true);
  expect(job.status).toBe('running');
  expect(job.statusHistory).toHaveLength(1);
  expect(job.statusHistory[0]).toMatchObject({ from: 'pending', to: 'running', reason: 'dispatched', source: 'test' });
  expect(typeof job.statusHistory[0].at).toBe('string');

  const records = readAuditRecordsForSlug(slug);
  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({ kind: 'job_transition', slug, from: 'pending', to: 'running', reason: 'dispatched', source: 'test', cwd: '/tmp/proj' });
});

test('an illegal transition refuses: job untouched, error logged, counter incremented, audit written', () => {
  const slug = uniqueSlug('illegal');
  const job = { slug, cwd: '/tmp/proj', status: 'pending' };
  const before = getRefusedTransitionCount();

  const ok = transitionJob(job, 'needs_review', { reason: 'bogus', source: 'test' });

  expect(ok).toBe(false);
  expect(job.status).toBe('pending'); // untouched
  expect(job.statusHistory).toBeUndefined(); // never mutated
  expect(getRefusedTransitionCount()).toBe(before + 1);

  const records = readAuditRecordsForSlug(slug);
  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({ kind: 'job_transition_refused', slug, from: 'pending', to: 'needs_review' });
});

test('an identity transition (status unchanged) is accepted as a no-op with no history entry', () => {
  const slug = uniqueSlug('identity');
  const job = { slug, cwd: '/tmp/proj', status: 'running' };

  const ok = transitionJob(job, 'running', { reason: 'no-op', source: 'test' });

  expect(ok).toBe(true);
  expect(job.status).toBe('running');
  expect(job.statusHistory).toBeUndefined();
  expect(readAuditRecordsForSlug(slug)).toHaveLength(0);
});

test('statusHistory caps at STATUS_HISTORY_CAP entries, dropping the oldest first', () => {
  const slug = uniqueSlug('cap');
  const job = { slug, cwd: '/tmp/proj', status: 'pending' };

  // pending -> running -> pending -> running -> ... alternate legally more
  // than the cap, to exercise eviction.
  const cycles = STATUS_HISTORY_CAP + 5;
  for (let i = 0; i < cycles; i++) {
    const to = job.status === 'pending' ? 'running' : 'pending';
    expect(transitionJob(job, to, { reason: `cycle ${i}`, source: 'test' })).toBe(true);
  }

  expect(job.statusHistory).toHaveLength(STATUS_HISTORY_CAP);
  // Oldest entries (early cycles) were dropped — the earliest surviving
  // entry's reason should be from a late cycle, not "cycle 0".
  expect(job.statusHistory[0].reason).not.toBe('cycle 0');
  expect(job.statusHistory[job.statusHistory.length - 1].reason).toBe(`cycle ${cycles - 1}`);
});

test('LEGAL_TRANSITIONS covers every real scheduler.cjs edge', () => {
  // Spot-check the edges scheduler.cjs actually exercises, so a future prune
  // of this table can't silently break a real call site without a test
  // failure here pointing at it.
  const mustBeLegal = [
    ['pending', 'running'],
    ['pending', 'completed'],
    ['pending', 'failed'],
    ['running', 'completed'],
    ['running', 'failed'],
    ['running', 'needs_review'],
    ['running', 'skipped'],
    ['running', 'pending'],
    ['investigating', 'failed'],
    ['investigating', 'needs_review'],
    ['investigating', 'pending'],
    ['failed', 'investigating'],
    ['failed', 'pending'],
    ['failed', 'completed'],
    ['needs_review', 'investigating'],
    ['needs_review', 'pending'],
    ['needs_review', 'completed'],
    ['needs_review', 'running'],
    ['completed', 'pending'],
    ['skipped', 'pending'],
  ];
  for (const [from, to] of mustBeLegal) {
    expect(LEGAL_TRANSITIONS[from]).toContain(to);
  }
});

test('running -> skipped is legal (a job whose PRD source vanished before dispatch never ran)', () => {
  const slug = uniqueSlug('skip');
  const job = { slug, cwd: '/tmp/proj', status: 'running' };

  const ok = transitionJob(job, 'skipped', { reason: 'PRD source no longer exists on disk', source: 'spawnJob:skip-archived' });

  expect(ok).toBe(true);
  expect(job.status).toBe('skipped');
  expect(job.statusHistory[0]).toMatchObject({ from: 'running', to: 'skipped' });
});

test('skipped is terminal: no transitions out except the explicit pending reset', () => {
  expect(LEGAL_TRANSITIONS.skipped).toEqual(['pending']);
  const slug = uniqueSlug('skip-terminal');
  const job = { slug, cwd: '/tmp/proj', status: 'skipped' };
  expect(transitionJob(job, 'running', { reason: 'nope', source: 'test' })).toBe(false);
  expect(transitionJob(job, 'completed', { reason: 'nope', source: 'test' })).toBe(false);
  expect(job.status).toBe('skipped');
  expect(transitionJob(job, 'pending', { reason: 'reset', source: 'test' })).toBe(true);
  expect(job.status).toBe('pending');
});

test('a genuinely nonsensical edge (completed -> running) is illegal', () => {
  expect(LEGAL_TRANSITIONS.completed).not.toContain('running');
  const slug = uniqueSlug('nonsense');
  const job = { slug, cwd: '/tmp/proj', status: 'completed' };
  expect(transitionJob(job, 'running', { reason: 'nope', source: 'test' })).toBe(false);
  expect(job.status).toBe('completed');
});

test('transitionJob never throws on a missing/malformed job', () => {
  expect(transitionJob(null, 'running', {})).toBe(false);
  expect(transitionJob(undefined, 'running', {})).toBe(false);
  // status undefined -> 'running' is not a legal edge from any known state —
  // refused, not a crash.
  expect(transitionJob({}, 'running', {})).toBe(false);
});

test('_resetRefusedTransitionCountForTests resets the counter', () => {
  const slug = uniqueSlug('reset-counter');
  const job = { slug, status: 'completed' };
  transitionJob(job, 'running', {});
  expect(getRefusedTransitionCount()).toBeGreaterThan(0);
  _resetRefusedTransitionCountForTests();
  expect(getRefusedTransitionCount()).toBe(0);
});

// ---------- needs_review ledger (PRD: needs_review durability) ----------
//
// transitionJob is the ONE place every needs_review entry/resolution is
// decided (this file's own header comment) — these tests exercise that
// hook directly rather than going through scheduler.cjs's many call sites.
// queueHistory.appendHistory is mocked so these tests never touch disk or
// race its own fire-and-forget promise; queueHistory.test.cjs already
// covers appendHistory's real I/O.

let appendHistorySpy;

beforeEach(() => {
  appendHistorySpy = vi.spyOn(queueHistory, 'appendHistory').mockResolvedValue({ appended: 1 });
});

afterEach(() => {
  appendHistorySpy.mockRestore();
});

test('needs_review entry: transitioning INTO needs_review appends a kind:needs_review_entry ledger line', () => {
  const slug = uniqueSlug('nr-entry');
  const job = { slug, cwd: '/tmp/proj', status: 'running', runId: 'run-abc', verifierVerdict: 'uncommitted_changes' };

  transitionJob(job, 'needs_review', { reason: 'finish protocol incomplete', source: 'spawnJob:finalize' });

  expect(appendHistorySpy).toHaveBeenCalledTimes(1);
  const [lines] = appendHistorySpy.mock.calls[0];
  expect(lines).toHaveLength(1);
  expect(lines[0]).toMatchObject({
    kind: 'needs_review_entry',
    slug,
    cwd: '/tmp/proj',
    runId: 'run-abc',
    reason: 'uncommitted_changes',
    source: 'spawnJob:finalize',
  });
  expect(typeof lines[0].at).toBe('string');
  // Episode bookkeeping stamped on the job so a later resolution can
  // reference this SAME runId even if job.runId is reassigned meanwhile.
  expect(job.needsReviewEntryRunId).toBe('run-abc');
  expect(job.needsReviewEnteredAt).toBe(lines[0].at);
});

test('needs_review resolution: transitioning OUT of needs_review appends a paired line referencing the ENTRY runId, with dwellMs', () => {
  const slug = uniqueSlug('nr-resolve');
  const job = { slug, cwd: '/tmp/proj', status: 'running', runId: 'run-1' };

  transitionJob(job, 'needs_review', { reason: 'park', source: 'spawnJob:finalize' });
  const enteredAt = job.needsReviewEnteredAt;

  // A resume-recovery re-dispatch (or any later attempt) mints a FRESH runId
  // before this episode resolves — the resolution must still reference the
  // ENTRY's runId, not whatever the job carries now.
  job.runId = 'run-2';
  transitionJob(job, 'completed', { reason: 'boot reverify: stale needs_review healed', source: 'reverifyNeedsReview:heal' });

  expect(appendHistorySpy).toHaveBeenCalledTimes(2);
  const [resolutionLines] = appendHistorySpy.mock.calls[1];
  expect(resolutionLines).toHaveLength(1);
  const resolution = resolutionLines[0];
  expect(resolution.kind).toBe('needs_review_resolution');
  expect(resolution.runId).toBe('run-1'); // the ENTRY's runId
  expect(resolution.resolvedTo).toBe('completed');
  expect(resolution.ladderRung).toBe('reverify');
  expect(typeof resolution.dwellMs).toBe('number');
  expect(resolution.dwellMs).toBeGreaterThanOrEqual(0);
  expect(Date.parse(enteredAt) + resolution.dwellMs).toBe(Date.parse(resolution.at));

  // Episode bookkeeping cleared once resolved.
  expect(job.needsReviewEntryRunId).toBeUndefined();
  expect(job.needsReviewEnteredAt).toBeUndefined();
});

test('a slug that parks twice produces two independent entry/resolution pairs, not one merged episode', () => {
  const { reduceNeedsReviewLedger } = require('../lib/needsReviewLedger.cjs');
  const slug = uniqueSlug('nr-twice');
  const job = { slug, cwd: '/tmp/proj', status: 'running', runId: 'run-A' };

  transitionJob(job, 'needs_review', { reason: 'park 1', source: 'spawnJob:finalize' });
  transitionJob(job, 'pending', { reason: 'manual reset', source: 'ipc:schedule:reset-job' });
  transitionJob(job, 'running', { reason: 'redispatched', source: 'spawnJob:dispatch' });
  job.runId = 'run-B';
  transitionJob(job, 'needs_review', { reason: 'park 2', source: 'spawnJob:finalize' });
  transitionJob(job, 'completed', { reason: 'healed', source: 'reverifyNeedsReview:heal' });

  const ledgerLines = appendHistorySpy.mock.calls.map((call) => call[0][0]);
  const entries = ledgerLines.filter((l) => l.kind === 'needs_review_entry');
  const resolutions = ledgerLines.filter((l) => l.kind === 'needs_review_resolution');
  expect(entries).toHaveLength(2);
  expect(resolutions).toHaveLength(2);
  expect(entries.map((l) => l.runId).sort()).toEqual(['run-A', 'run-B']);
  expect(resolutions.map((l) => l.runId).sort()).toEqual(['run-A', 'run-B']);

  const rollup = reduceNeedsReviewLedger(ledgerLines);
  expect(rollup.unresolvedCount).toBe(0);
  expect(rollup.byLadderRung['manual-reset']).toBe(1);
  expect(rollup.byLadderRung['reverify']).toBe(1);
});

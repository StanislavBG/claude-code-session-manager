/**
 * needsReviewLedger.test.cjs — unit tests for src/main/lib/needsReviewLedger.cjs's
 * pure ladder-rung classification, line builders, and rollup reduction.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/needsReviewLedger.test.cjs
 */
'use strict';

import { test, expect } from 'vitest';
const {
  LADDER_RUNGS,
  classifyLadderRung,
  buildNeedsReviewEntryLine,
  buildNeedsReviewResolutionLine,
  reduceNeedsReviewLedger,
} = require('../lib/needsReviewLedger.cjs');

// ---------- classifyLadderRung ----------

test('classifyLadderRung maps every known automated source to its named rung', () => {
  expect(classifyLadderRung({ source: 'scheduler:mechanicalRecovery' })).toBe('mechanical-recovery');
  expect(classifyLadderRung({ source: 'spawnJob:dispatch', reason: 'dispatched for resume-recovery' })).toBe('resume-recovery');
  expect(classifyLadderRung({ source: 'spawnInvestigation:start' })).toBe('auto-fix');
  expect(classifyLadderRung({ source: 'spawnJob:auto-promote' })).toBe('auto-fix');
  expect(classifyLadderRung({ source: 'reverifyNeedsReview:auto-promote' })).toBe('auto-fix');
  expect(classifyLadderRung({ source: 'reverifyNeedsReview:heal' })).toBe('reverify');
  expect(classifyLadderRung({ source: 'needsReviewAutoResolve' })).toBe('reverify');
});

test('classifyLadderRung: ordinary spawnJob:dispatch (no resume-recovery reason) is NOT resume-recovery', () => {
  // 'spawnJob:dispatch' is shared with the everyday pending->running dispatch
  // — only the resume-recovery REASON text distinguishes the two.
  expect(classifyLadderRung({ source: 'spawnJob:dispatch', reason: 'dispatched for execution' })).toBe('manual-reset');
});

test('classifyLadderRung: unrecognized/explicit-reset sources default to manual-reset', () => {
  expect(classifyLadderRung({ source: 'ipc:schedule:reset-job' })).toBe('manual-reset');
  expect(classifyLadderRung({ source: 'remote:resetJob' })).toBe('manual-reset');
  expect(classifyLadderRung({ source: 'clear-queue' })).toBe('manual-reset');
  expect(classifyLadderRung({})).toBe('manual-reset');
});

test('LADDER_RUNGS names exactly the 6 documented rungs', () => {
  expect(LADDER_RUNGS).toEqual(['mechanical-recovery', 'resume-recovery', 'quarantine', 'auto-fix', 'reverify', 'manual-reset']);
});

// ---------- buildNeedsReviewEntryLine / buildNeedsReviewResolutionLine ----------

test('buildNeedsReviewEntryLine: park reason prefers verifierVerdict, then heldReason, then error', () => {
  const entry = { to: 'needs_review', source: 'spawnJob:finalize', at: '2026-09-13T00:00:00.000Z' };
  expect(buildNeedsReviewEntryLine({ slug: 's1', verifierVerdict: 'uncommitted_changes', heldReason: 'held', error: 'err' }, entry).reason).toBe('uncommitted_changes');
  expect(buildNeedsReviewEntryLine({ slug: 's1', heldReason: 'held', error: 'err' }, entry).reason).toBe('held');
  expect(buildNeedsReviewEntryLine({ slug: 's1', error: 'err' }, entry).reason).toBe('err');
  expect(buildNeedsReviewEntryLine({ slug: 's1' }, entry).reason).toBeNull();
});

test('buildNeedsReviewEntryLine: carries slug/cwd/epicId/runId/at/source verbatim', () => {
  const job = { slug: '42-x', cwd: '/proj', epicId: 'epic-1', runId: 'run-9' };
  const entry = { to: 'needs_review', source: 'spawnJob:finalize', at: '2026-09-13T00:00:00.000Z' };
  const line = buildNeedsReviewEntryLine(job, entry);
  expect(line).toEqual({
    kind: 'needs_review_entry',
    slug: '42-x',
    cwd: '/proj',
    epicId: 'epic-1',
    runId: 'run-9',
    at: '2026-09-13T00:00:00.000Z',
    reason: null,
    source: 'spawnJob:finalize',
  });
});

test('buildNeedsReviewResolutionLine: references the EPISODE runId, not job.runId, and computes dwellMs', () => {
  const job = { slug: '42-x', cwd: '/proj', epicId: 'epic-1', runId: 'run-LATER' };
  const entry = { to: 'completed', source: 'reverifyNeedsReview:heal', at: '2026-09-13T00:10:00.000Z' };
  const episode = { runId: 'run-ORIGINAL', enteredAt: '2026-09-13T00:00:00.000Z' };
  const line = buildNeedsReviewResolutionLine(job, entry, episode);
  expect(line.runId).toBe('run-ORIGINAL');
  expect(line.resolvedTo).toBe('completed');
  expect(line.ladderRung).toBe('reverify');
  expect(line.dwellMs).toBe(10 * 60_000);
});

test('buildNeedsReviewResolutionLine: dwellMs is null when the episode has no enteredAt (defensive — should not happen in practice)', () => {
  const job = { slug: '42-x', runId: 'run-1' };
  const entry = { to: 'failed', source: 'ipc:schedule:reset-job', at: '2026-09-13T00:00:00.000Z' };
  const line = buildNeedsReviewResolutionLine(job, entry, { runId: 'run-1', enteredAt: null });
  expect(line.dwellMs).toBeNull();
});

// ---------- reduceNeedsReviewLedger ----------

function entryLine({ slug, runId, at, reason = 'uncommitted_changes', source = 'spawnJob:finalize' }) {
  return { kind: 'needs_review_entry', slug, cwd: null, epicId: null, runId, at, reason, source };
}
function resolutionLine({ slug, runId, at, resolvedTo = 'completed', ladderRung = 'reverify', source = 'reverifyNeedsReview:heal', dwellMs = 1000 }) {
  return { kind: 'needs_review_resolution', slug, cwd: null, epicId: null, runId, at, resolvedTo, ladderRung, source, dwellMs };
}

test('reduceNeedsReviewLedger: entry-only (unresolved) episode counts toward byReason and unresolvedCount, not byLadderRung', () => {
  const lines = [entryLine({ slug: 'a', runId: 'r1', at: '2026-09-13T00:00:00.000Z', reason: 'silent_no_op' })];
  const rollup = reduceNeedsReviewLedger(lines);
  expect(rollup.byReason).toEqual({ silent_no_op: 1 });
  expect(rollup.byLadderRung).toEqual({});
  expect(rollup.unresolvedCount).toBe(1);
  expect(rollup.dwellMsP50).toBeNull();
  expect(rollup.dwellMsP90).toBeNull();
});

test('reduceNeedsReviewLedger: entry+resolution pair resolves and contributes dwell', () => {
  const lines = [
    entryLine({ slug: 'a', runId: 'r1', at: '2026-09-13T00:00:00.000Z' }),
    resolutionLine({ slug: 'a', runId: 'r1', at: '2026-09-13T00:00:05.000Z', dwellMs: 5000, ladderRung: 'mechanical-recovery' }),
  ];
  const rollup = reduceNeedsReviewLedger(lines);
  expect(rollup.unresolvedCount).toBe(0);
  expect(rollup.byLadderRung).toEqual({ 'mechanical-recovery': 1 });
  expect(rollup.dwellMsP50).toBe(5000);
  expect(rollup.dwellMsP90).toBe(5000);
});

test('reduceNeedsReviewLedger: repeated entries for the same slug (different runIds) count as independent episodes', () => {
  const lines = [
    entryLine({ slug: 'a', runId: 'r1', at: '2026-09-13T00:00:00.000Z', reason: 'uncommitted_changes' }),
    resolutionLine({ slug: 'a', runId: 'r1', at: '2026-09-13T00:00:10.000Z', dwellMs: 10_000, ladderRung: 'manual-reset' }),
    entryLine({ slug: 'a', runId: 'r2', at: '2026-09-13T01:00:00.000Z', reason: 'uncommitted_changes' }),
    // r2 never resolves.
  ];
  const rollup = reduceNeedsReviewLedger(lines);
  expect(rollup.byReason).toEqual({ uncommitted_changes: 2 });
  expect(rollup.unresolvedCount).toBe(1);
  expect(rollup.byLadderRung).toEqual({ 'manual-reset': 1 });
  expect(rollup.dwellMsP50).toBe(10_000);
});

test('reduceNeedsReviewLedger: p50/p90 over several resolved episodes', () => {
  const dwells = [1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000, 10_000];
  const lines = dwells.flatMap((d, i) => [
    entryLine({ slug: `s${i}`, runId: `r${i}`, at: '2026-09-13T00:00:00.000Z' }),
    resolutionLine({ slug: `s${i}`, runId: `r${i}`, at: '2026-09-13T00:00:00.000Z', dwellMs: d }),
  ]);
  const rollup = reduceNeedsReviewLedger(lines);
  expect(rollup.dwellMsP50).toBe(5000);
  expect(rollup.dwellMsP90).toBe(9000);
});

test('reduceNeedsReviewLedger: ignores unrelated (terminal) rows mixed into the same lines array', () => {
  const lines = [
    { kind: 'terminal', slug: 'a', status: 'completed', runId: 'r1' },
    { slug: 'b', status: 'failed', runId: 'r2' }, // legacy row, no kind at all
    entryLine({ slug: 'c', runId: 'r3', at: '2026-09-13T00:00:00.000Z' }),
  ];
  const rollup = reduceNeedsReviewLedger(lines);
  expect(rollup.unresolvedCount).toBe(1);
  expect(Object.keys(rollup.byReason)).toEqual(['uncommitted_changes']);
});

test('reduceNeedsReviewLedger: empty/non-array input returns a zeroed rollup, never throws', () => {
  expect(reduceNeedsReviewLedger([])).toEqual({ byReason: {}, byLadderRung: {}, unresolvedCount: 0, dwellMsP50: null, dwellMsP90: null });
  expect(reduceNeedsReviewLedger(null)).toEqual({ byReason: {}, byLadderRung: {}, unresolvedCount: 0, dwellMsP50: null, dwellMsP90: null });
  expect(reduceNeedsReviewLedger(undefined)).toEqual({ byReason: {}, byLadderRung: {}, unresolvedCount: 0, dwellMsP50: null, dwellMsP90: null });
});

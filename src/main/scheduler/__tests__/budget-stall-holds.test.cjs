'use strict';

// Stall detector must classify long-pending rows by cause and stop treating
// cancelled/completed rows as problems. Self, 2026-11-22: 5 cancelled rows of a
// closed Epic (1012-1016) flagged a stall every ~8 min, while 16 pending rows
// held behind a cancelled dependency were never reported at all.
//
// Run: timeout 300 npx vitest run src/main/scheduler/__tests__/budget-stall-holds.test.cjs

import { describe, it, expect } from 'vitest';
const {
  computeStallSummary, isCancelledRow, isNonProblemRow, classifyPendingHolds, findDependencyStalledProjects,
} = require('../budget.cjs');

const CWD = '/proj/self';
const EPIC = 'epic-self';
const NOW = Date.parse('2026-11-22T12:00:00Z');
const OLD = '2026-11-22T10:00:00Z';
const MIN = 60_000;

const cancelled = (slug, extra = {}) => ({
  slug, cwd: CWD, epicId: EPIC, status: 'failed', cancelledAt: '2026-11-22T09:00:00Z', ...extra,
});

describe('computeStallSummary: cancelled + completed rows are not problems', () => {
  it('cancel markers: cancelledAt or the admin-API error', () => {
    expect(isCancelledRow({ status: 'failed', cancelledAt: OLD })).toBe(true);
    expect(isCancelledRow({ status: 'failed', error: 'cancelled via admin API (by human)' })).toBe(true);
    expect(isCancelledRow({ status: 'failed', error: 'exit 1' })).toBe(false);
    expect(isNonProblemRow({ status: 'failed', error: 'cancelled via admin API' })).toBe(true);
    expect(isNonProblemRow({ status: 'completed' })).toBe(true);
    expect(isNonProblemRow({ status: 'failed', error: 'exit 1' })).toBe(false);
  });

  it('a project holding only cancelled (and completed) rows is NOT stalled', () => {
    const jobs = [
      ...[1012, 1013, 1014].map((n) => cancelled(`${n}-x`)),
      { slug: '1015-y', cwd: CWD, status: 'failed', error: 'cancelled via admin API' },
      { slug: '1016-z', cwd: CWD, status: 'completed' },
    ];
    const summary = computeStallSummary({ jobs, invalidJobs: [], paused: null });
    expect(summary.stalled).toBe(false);
    expect(summary.byProject[CWD].stalled).toBe(false);
    expect(summary.byProject[CWD].failed).toBe(4); // counts stay a pure status tally
  });

  it('a genuinely failed row beside cancelled ones still reads stalled', () => {
    const jobs = [cancelled('1012-x'), { slug: '1020-real', cwd: CWD, status: 'failed', error: 'exit 1' }];
    const summary = computeStallSummary({ jobs, invalidJobs: [], paused: null });
    expect(summary.stalled).toBe(true);
    expect(summary.byProject[CWD].stalled).toBe(true);
  });
});

describe('classifyPendingHolds', () => {
  it('names the blocking row and its status for a dependency hold', () => {
    const jobs = [
      cancelled('1056-sm-contract-client'),
      { slug: '1060-a', cwd: CWD, epicId: EPIC, status: 'pending', createdAt: OLD, dependsOn: ['1056-sm-contract-client'] },
      { slug: '1061-b', cwd: CWD, epicId: EPIC, status: 'pending', createdAt: OLD, dependsOn: ['1060-a'] },
      { slug: '1062-c', cwd: CWD, epicId: EPIC, status: 'pending', createdAt: OLD, dependsOn: ['never-existed'] },
    ];
    const out = classifyPendingHolds(jobs, {
      satisfiedSlugsByCwd: new Map([[CWD, new Set()]]), holds: [], now: NOW, thresholdMs: MIN,
    });
    const by = Object.fromEntries(out.map((c) => [c.slug, c]));
    expect(by['1060-a']).toMatchObject({
      cause: 'dependency', dep: '1056-sm-contract-client', depSlug: '1056-sm-contract-client', depStatus: 'cancelled',
    });
    expect(by['1061-b']).toMatchObject({
      cause: 'dependency', depSlug: '1060-a', depStatus: 'pending', rootSlug: '1056-sm-contract-client', rootStatus: 'cancelled',
    });
    expect(by['1062-c']).toMatchObject({ cause: 'dependency', dep: 'never-existed', depSlug: null, depStatus: 'unresolved' });

    const stalled = findDependencyStalledProjects(jobs, out);
    expect(stalled[CWD]).toEqual([
      { slug: '1060-a', dep: '1056-sm-contract-client', depSlug: '1056-sm-contract-client', depStatus: 'cancelled' },
      { slug: '1061-b', dep: '1060-a', depSlug: '1060-a', depStatus: 'pending' },
      { slug: '1062-c', dep: 'never-existed', depSlug: null, depStatus: 'unresolved' },
    ]);
  });

  it('a dep satisfied by a completed record is not a hold (cancelled duplicate ignored)', () => {
    const jobs = [
      cancelled('1056-sm-contract-client'),
      { slug: '1060-a', cwd: CWD, epicId: EPIC, status: 'pending', createdAt: OLD, dependsOn: ['sm-contract-client'] },
    ];
    const out = classifyPendingHolds(jobs, {
      satisfiedSlugsByCwd: new Map([[CWD, new Set(['1047-sm-contract-client'])]]), now: NOW, thresholdMs: MIN,
    });
    expect(out).toEqual([expect.objectContaining({ slug: '1060-a', cause: 'concurrency' })]);
    expect(findDependencyStalledProjects(jobs, out)).toEqual({});
  });

  it('files-overlap, load-gate, concurrency, and the age threshold', () => {
    const jobs = [
      { slug: '1-a', cwd: CWD, status: 'pending', createdAt: OLD },
      { slug: '2-b', cwd: CWD, status: 'pending', createdAt: OLD },
      { slug: '3-fresh', cwd: CWD, status: 'pending', createdAt: new Date(NOW - 1000).toISOString() },
    ];
    const holds = [{ slug: '1-a', dep: null, depStatus: null, reason: 'files-overlap:9-running' }];
    const base = { satisfiedSlugsByCwd: new Map(), holds, now: NOW, thresholdMs: MIN };
    const out = classifyPendingHolds(jobs, base);
    expect(out.map((c) => c.slug)).toEqual(['1-a', '2-b']);
    expect(out[0]).toMatchObject({ cause: 'files-overlap', overlapWith: '9-running' });
    expect(out[1].cause).toBe('concurrency');
    expect(classifyPendingHolds(jobs, { ...base, loadGated: true })[1].cause).toBe('load-gate');
  });

  it('a dependency on a still-pending/running row is not a dependency stall', () => {
    const jobs = [
      { slug: '1-root', cwd: CWD, status: 'running' },
      { slug: '2-dep', cwd: CWD, status: 'pending', createdAt: OLD, dependsOn: ['1-root'] },
    ];
    const out = classifyPendingHolds(jobs, { satisfiedSlugsByCwd: new Map(), now: NOW, thresholdMs: MIN });
    expect(out[0]).toMatchObject({ cause: 'dependency', depStatus: 'running' });
    expect(findDependencyStalledProjects(jobs, out)).toEqual({});
  });
});

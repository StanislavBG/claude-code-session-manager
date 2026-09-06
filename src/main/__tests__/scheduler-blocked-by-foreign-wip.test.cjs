/**
 * scheduler-blocked-by-foreign-wip.test.cjs — validateForeignWipBlockClaim
 * (the manifest-membership check that stops an executor from laundering a
 * real regression into a BLOCKED_BY_FOREIGN_WIP verdict) and
 * requeueForeignWipBlockedJobs (reconcile()'s auto-clear-and-resume pass).
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/scheduler-blocked-by-foreign-wip.test.cjs
 */

'use strict';

import { test, expect } from 'vitest';
const {
  validateForeignWipBlockClaim,
  requeueForeignWipBlockedJobs,
  FOREIGN_WIP_BLOCK_STREAK_LIMIT,
} = require('../scheduler.cjs');

// ─── validateForeignWipBlockClaim ──────────────────────────────────────────

test('validateForeignWipBlockClaim: ok when every claimed path is in preRunDirtyPaths', () => {
  const job = { preRunDirtyPaths: ['src/a.ts', 'src/b.ts'] };
  const v = validateForeignWipBlockClaim(['src/a.ts'], job);
  expect(v.ok).toBe(true);
  expect(v.validPaths).toEqual(['src/a.ts']);
  expect(v.invalidPaths).toEqual([]);
});

test('validateForeignWipBlockClaim: ok when every claimed path is in carriedPaths', () => {
  const job = { carriedPaths: ['config/settings.json'] };
  const v = validateForeignWipBlockClaim(['config/settings.json'], job);
  expect(v.ok).toBe(true);
  expect(v.validPaths).toEqual(['config/settings.json']);
});

test('validateForeignWipBlockClaim: rejects an unlisted path — the launder-a-regression case', () => {
  // The job's real, disclosed foreign-WIP manifest never mentioned this path
  // — an executor naming it anyway must not get away with claiming a block.
  const job = { preRunDirtyPaths: ['src/a.ts'] };
  const v = validateForeignWipBlockClaim(['src/a.ts', 'src/my-own-broken-file.ts'], job);
  expect(v.ok).toBe(false);
  expect(v.validPaths).toEqual(['src/a.ts']);
  expect(v.invalidPaths).toEqual(['src/my-own-broken-file.ts']);
});

test('validateForeignWipBlockClaim: rejects a claim naming ONLY an unlisted path', () => {
  const job = { preRunDirtyPaths: ['src/a.ts'] };
  const v = validateForeignWipBlockClaim(['src/totally-unrelated.ts'], job);
  expect(v.ok).toBe(false);
  expect(v.invalidPaths).toEqual(['src/totally-unrelated.ts']);
});

test('validateForeignWipBlockClaim: rejects an empty claim (no evidence at all)', () => {
  const job = { preRunDirtyPaths: ['src/a.ts'] };
  expect(validateForeignWipBlockClaim([], job).ok).toBe(false);
  expect(validateForeignWipBlockClaim(null, job).ok).toBe(false);
});

test('validateForeignWipBlockClaim: rejects against an empty/missing manifest', () => {
  expect(validateForeignWipBlockClaim(['src/a.ts'], {}).ok).toBe(false);
  expect(validateForeignWipBlockClaim(['src/a.ts'], null).ok).toBe(false);
});

// ─── requeueForeignWipBlockedJobs ──────────────────────────────────────────

test('requeueForeignWipBlockedJobs: promotes skipped/blocked job to pending once its paths are clean', async () => {
  const job = {
    slug: '10-foo', status: 'skipped', cwd: '/repo', blockedByForeignWip: true,
    foreignWipBlockedPaths: ['src/a.ts'], statusHistory: [],
  };
  await requeueForeignWipBlockedJobs([job], { getDirtyPaths: async () => [] });
  expect(job.status).toBe('pending');
  expect(job.blockedByForeignWip).toBeUndefined();
  expect(job.foreignWipBlockedPaths).toBeUndefined();
});

test('requeueForeignWipBlockedJobs: leaves the job parked while any blocked path is still dirty', async () => {
  const job = {
    slug: '10-foo', status: 'skipped', cwd: '/repo', blockedByForeignWip: true,
    foreignWipBlockedPaths: ['src/a.ts', 'src/b.ts'], statusHistory: [],
  };
  await requeueForeignWipBlockedJobs([job], { getDirtyPaths: async () => ['src/a.ts'] });
  expect(job.status).toBe('skipped');
  expect(job.blockedByForeignWip).toBe(true);
});

test('requeueForeignWipBlockedJobs: ignores jobs not in the blocked-skipped shape', async () => {
  const skippedNotBlocked = { slug: '1', status: 'skipped', cwd: '/repo', statusHistory: [] };
  const runningBlocked = { slug: '2', status: 'running', cwd: '/repo', blockedByForeignWip: true, foreignWipBlockedPaths: ['x'], statusHistory: [] };
  const getDirtyPaths = async () => [];
  await requeueForeignWipBlockedJobs([skippedNotBlocked, runningBlocked], { getDirtyPaths });
  expect(skippedNotBlocked.status).toBe('skipped');
  expect(runningBlocked.status).toBe('running');
});

test('requeueForeignWipBlockedJobs: leaves the row alone when the cwd is not a git repo (getDirtyPaths → null)', async () => {
  const job = {
    slug: '10-foo', status: 'skipped', cwd: '/not-a-repo', blockedByForeignWip: true,
    foreignWipBlockedPaths: ['src/a.ts'], statusHistory: [],
  };
  await requeueForeignWipBlockedJobs([job], { getDirtyPaths: async () => null });
  expect(job.status).toBe('skipped');
});

test('FOREIGN_WIP_BLOCK_STREAK_LIMIT is 3', () => {
  expect(FOREIGN_WIP_BLOCK_STREAK_LIMIT).toBe(3);
});

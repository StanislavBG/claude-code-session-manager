/**
 * jobWorktreeBootLive.test.cjs — PRD 1162: pure unit tests for the `isLive`
 * predicate the scheduler's boot worktree sweep hands to
 * jobWorktree.reconcileWorktreesOnBoot. Liveness is fully injected/stubbed —
 * no /proc, no git, no electron.
 *
 * Run: timeout 60 npx vitest run src/main/lib/git/__tests__/jobWorktreeBootLive.test.cjs
 */

'use strict';

import { test, expect, vi } from 'vitest';
const { buildJobWorktreeIsLive } = require('../jobWorktreeBootLive.cjs');

test('isLive returns true when the row is running with a live pid', () => {
  const claudePidAlive = vi.fn(() => true);
  const hasLiveHolder = vi.fn(() => false);
  const isLive = buildJobWorktreeIsLive({
    bootJobs: [{ slug: 'job-a', status: 'running', runtime: { pid: 4242 } }],
    claudePidAlive,
    hasLiveHolder,
  });
  expect(isLive('job-a', { worktree: '/tmp/whatever' })).toBe(true);
  expect(claudePidAlive).toHaveBeenCalledWith(4242);
  expect(hasLiveHolder).not.toHaveBeenCalled();
});

test('isLive returns false when the row is running but the pid is dead and no cwd holder exists', () => {
  const isLive = buildJobWorktreeIsLive({
    bootJobs: [{ slug: 'job-a', status: 'running', runtime: { pid: 4242 } }],
    claudePidAlive: () => false,
    hasLiveHolder: () => false,
  });
  expect(isLive('job-a', { worktree: '/tmp/whatever' })).toBe(false);
});

test('isLive returns true via hasLiveHolder when the row is absent/terminal but a process still holds the checkout as cwd', () => {
  const claudePidAlive = vi.fn(() => true);
  const hasLiveHolder = vi.fn(() => true);
  const isLive = buildJobWorktreeIsLive({
    bootJobs: [{ slug: 'job-b', status: 'completed', runtime: { pid: 999 } }],
    claudePidAlive,
    hasLiveHolder,
  });
  expect(isLive('job-b', { worktree: '/tmp/checkout-b' })).toBe(true);
  // Terminal row never even consults claudePidAlive — only a 'running' row does.
  expect(claudePidAlive).not.toHaveBeenCalled();
  expect(hasLiveHolder).toHaveBeenCalledWith('/tmp/checkout-b', undefined);
});

test('isLive returns false when there is no matching row and no cwd holder', () => {
  const isLive = buildJobWorktreeIsLive({
    bootJobs: [],
    claudePidAlive: () => true,
    hasLiveHolder: () => false,
  });
  expect(isLive('job-c', { worktree: '/tmp/checkout-c' })).toBe(false);
});

test('a precomputed cwdHolders set is forwarded through to hasLiveHolder unchanged', () => {
  const holders = new Set(['/tmp/precomputed']);
  const hasLiveHolder = vi.fn(() => false);
  const isLive = buildJobWorktreeIsLive({
    bootJobs: [],
    claudePidAlive: () => false,
    hasLiveHolder,
    cwdHolders: holders,
  });
  isLive('job-d', { worktree: '/tmp/checkout-d' });
  expect(hasLiveHolder).toHaveBeenCalledWith('/tmp/checkout-d', holders);
});

test('rowPid (the record/log ladder) is consulted instead of runtime.pid alone', () => {
  const claudePidAlive = vi.fn((pid) => pid === 777);
  const isLive = buildJobWorktreeIsLive({
    bootJobs: [{ slug: 'job-e', status: 'running' }],
    claudePidAlive,
    hasLiveHolder: () => false,
    rowPid: () => 777,
  });
  expect(isLive('job-e', { worktree: '/tmp/checkout-e' })).toBe(true);
});

test('PRD 2908: an adopted slug with a dead pid and no cwd holder is live', () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    const isLive = buildJobWorktreeIsLive({
      bootJobs: [{ slug: 'job-f', status: 'running', runtime: { pid: 4242 } }],
      claudePidAlive: () => false,
      hasLiveHolder: () => false,
      adoptedSlugs: new Set(['job-f']),
    });
    expect(isLive('job-f', { worktree: '/tmp/checkout-f' })).toBe(true);
    const lines = log.mock.calls.map((c) => String(c[0]));
    expect(lines.filter((l) => l.includes('slug=job-f') && l.includes('adopted row, the reaper finalizes it'))).toHaveLength(1);
  } finally {
    log.mockRestore();
  }
});

test('PRD 2908: a non-adopted dead slug is not live (array form accepted)', () => {
  const isLive = buildJobWorktreeIsLive({
    bootJobs: [{ slug: 'job-g', status: 'running', runtime: { pid: 4242 } }],
    claudePidAlive: () => false,
    hasLiveHolder: () => false,
    adoptedSlugs: ['job-other'],
  });
  expect(isLive('job-g', { worktree: '/tmp/checkout-g' })).toBe(false);
  expect(isLive('job-other', { worktree: '/tmp/checkout-o' })).toBe(true);
});

test('PRD 2908: no adoptedSlugs behaves as before — dead pid, no holder → not live', () => {
  const isLive = buildJobWorktreeIsLive({
    bootJobs: [{ slug: 'job-h', status: 'running', runtime: { pid: 4242 } }],
    claudePidAlive: () => false,
    hasLiveHolder: () => false,
  });
  expect(isLive('job-h', { worktree: '/tmp/checkout-h' })).toBe(false);
});

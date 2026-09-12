/**
 * health-worktree-cap-blocked.test.cjs — `npm run health` must report
 * non-GREEN when the worktree cap (gitWorktree.cjs's reserveWorktreeSlot) is
 * blocking every dispatchable pending job with nothing running. Before this
 * check existed that state was invisible to health.cjs: rows in four
 * separate project queues carried heldReason 'worktree cap reached (5
 * concurrent)' for 16 hours with zero entries in
 * session-manager-operations/logs/ and nothing non-GREEN here — only a
 * console.log line and the heldReason field itself, which nothing surfaced.
 *
 * Exercises evaluateWorktreeCapBlocked() directly — pure, no fs — matching
 * every other evaluate* helper's test pattern in this file (see
 * health-usage-poller.test.cjs's header).
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/health-worktree-cap-blocked.test.cjs
 */

'use strict';

import { test, expect } from 'vitest';
const { evaluateWorktreeCapBlocked } = require('../health.cjs');

test('a pending job held on "worktree cap reached" with 0 running is non-GREEN, blocked', () => {
  const jobs = [
    { slug: 'a', status: 'pending', heldReason: 'worktree cap reached (5 concurrent)' },
    { slug: 'b', status: 'pending', heldReason: 'worktree cap reached (5 concurrent)' },
  ];
  const result = evaluateWorktreeCapBlocked(jobs, 0);
  expect(result.ok).toBe(false);
  expect(result.blocked).toBe(true);
  expect(result.capBlockedSlugs).toEqual(['a', 'b']);
});

test('accepts a job map (queueStore.readMergedSync federated shape), not just an array', () => {
  const jobs = {
    a: { slug: 'a', status: 'pending', heldReason: 'worktree cap reached (5 concurrent)' },
    b: { slug: 'b', status: 'completed' },
  };
  const result = evaluateWorktreeCapBlocked(jobs, 0);
  expect(result.ok).toBe(false);
  expect(result.capBlockedSlugs).toEqual(['a']);
});

test('the same cap-reached row stays GREEN while at least one job is running', () => {
  const jobs = [{ slug: 'a', status: 'pending', heldReason: 'worktree cap reached (5 concurrent)' }];
  const result = evaluateWorktreeCapBlocked(jobs, 1);
  expect(result.ok).toBe(true);
  expect(result.blocked).toBe(false);
});

test('a pending row with an unrelated heldReason (or none) stays GREEN', () => {
  const jobs = [
    { slug: 'a', status: 'pending', heldReason: 'launch blocked (rate_limit) — re-probe at 2026-09-11T00:00:00Z' },
    { slug: 'b', status: 'pending' },
  ];
  const result = evaluateWorktreeCapBlocked(jobs, 0);
  expect(result.ok).toBe(true);
  expect(result.blocked).toBe(false);
});

test('no pending jobs at all stays GREEN', () => {
  const result = evaluateWorktreeCapBlocked([], 0);
  expect(result.ok).toBe(true);
  expect(result.blocked).toBe(false);
});

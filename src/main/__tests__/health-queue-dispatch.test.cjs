/**
 * health-queue-dispatch.test.cjs — `npm run health` must report non-GREEN
 * when there is at least one DISPATCHABLE pending job (reusing
 * classifyQueueStarvation's own 'starved' verdict, not merely "pending"),
 * nothing running, and no dispatch attempt in a long time — the exact shape
 * of the 2026-09-11 incident (27 pending across two projects, 0 running, for
 * days, every other health surface reporting green). A dependsOn-blocked
 * queue must NOT trip this the same way: ticking can't fix a blocked chain,
 * so it stays GREEN (reported as 'blocked' instead, distinctly).
 *
 * Exercises evaluateQueueDispatchHealth() directly — pure, no fs — matching
 * every other evaluate* helper's test pattern in this file (see
 * health-usage-poller.test.cjs's header).
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/health-queue-dispatch.test.cjs
 */

'use strict';

import { test, expect } from 'vitest';
const { evaluateQueueDispatchHealth, DISPATCH_STALL_THRESHOLD_MS } = require('../health.cjs');

const CWD = '/home/bilko/Projects/starry-night-ships';
const NOW = Date.parse('2026-09-11T12:00:00.000Z');
const idleFor = (ms) => new Date(NOW - ms).toISOString();

test('a dispatchable pending job, 0 running, stale past the threshold — non-GREEN, starved', () => {
  const state = {
    jobs: [{ slug: 'a', cwd: CWD, status: 'pending', dependsOn: [] }],
    paused: null,
    lastDispatchAttemptAt: idleFor(DISPATCH_STALL_THRESHOLD_MS + 60_000),
  };
  const result = evaluateQueueDispatchHealth(state, 0, NOW);
  expect(result.ok).toBe(false);
  expect(result.starved).toBe(true);
  expect(result.dispatchable).toBe(1);
  expect(result.message).toMatch(/dispatch appears stuck/);
});

test('every pending row behind a blocked dependsOn chain stays GREEN, reported as blocked', () => {
  const state = {
    jobs: [
      { slug: 'dead', cwd: CWD, status: 'failed', dependsOn: [] },
      { slug: 'blocked-child', cwd: CWD, status: 'pending', dependsOn: ['dead'] },
    ],
    paused: null,
    lastDispatchAttemptAt: idleFor(DISPATCH_STALL_THRESHOLD_MS + 60_000),
  };
  const result = evaluateQueueDispatchHealth(state, 0, NOW);
  expect(result.ok).toBe(true);
  expect(result.blocked).toBe(true);
  expect(result.starved).toBeUndefined();
  expect(result.message).toMatch(/blocked/);
});

test('healthy queue (recent dispatch attempt) is GREEN with no verdict', () => {
  const state = {
    jobs: [{ slug: 'a', cwd: CWD, status: 'pending', dependsOn: [] }],
    paused: null,
    lastDispatchAttemptAt: idleFor(60_000),
  };
  const result = evaluateQueueDispatchHealth(state, 0, NOW);
  expect(result).toEqual({ ok: true });
});

test('nothing pending is GREEN regardless of how stale the dispatch timestamp is', () => {
  const state = {
    jobs: [{ slug: 'a', cwd: CWD, status: 'completed' }],
    paused: null,
    lastDispatchAttemptAt: idleFor(DISPATCH_STALL_THRESHOLD_MS + 60_000),
  };
  const result = evaluateQueueDispatchHealth(state, 0, NOW);
  expect(result).toEqual({ ok: true });
});

test('work already running is GREEN — the queue is flowing', () => {
  const state = {
    jobs: [{ slug: 'a', cwd: CWD, status: 'pending', dependsOn: [] }],
    paused: null,
    lastDispatchAttemptAt: idleFor(DISPATCH_STALL_THRESHOLD_MS + 60_000),
  };
  const result = evaluateQueueDispatchHealth(state, 1, NOW);
  expect(result).toEqual({ ok: true });
});

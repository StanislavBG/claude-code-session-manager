/**
 * queueHealth.test.cjs — computeQueueHealth: the pure per-project rollup
 * behind the periodic queue-health sweep (PRD 1109).
 *
 * Pure helper, no electron import — mirrors reaperHelpers.test.cjs's pattern
 * so it never needs scheduler.cjs's mocked IPC surface.
 *
 * Run: timeout 120 npx vitest run src/main/lib/__tests__/queueHealth.test.cjs
 */

'use strict';

import { test } from 'vitest';
const assert = require('node:assert/strict');
const { computeQueueHealth } = require('../queueHealth.cjs');

test('counts never_ran, looksDone, and stuck per project cwd', () => {
  const jobs = [
    { slug: 'a', cwd: '/proj-1', status: 'failed', gateOutcome: 'never_ran' },
    { slug: 'b', cwd: '/proj-1', status: 'failed', looksDone: { commits: ['abc1234'] } },
    { slug: 'c', cwd: '/proj-1', status: 'needs_review' },
    { slug: 'd', cwd: '/proj-2', status: 'quarantined' },
  ];
  const rollup = computeQueueHealth(jobs);
  const byProj = Object.fromEntries(rollup.map((r) => [r.cwd, r]));
  assert.deepStrictEqual(byProj['/proj-1'], { cwd: '/proj-1', neverRan: 1, looksDone: 1, stuck: 1 });
  assert.deepStrictEqual(byProj['/proj-2'], { cwd: '/proj-2', neverRan: 0, looksDone: 0, stuck: 1 });
});

test('a project with zero drift across all three counters is omitted entirely', () => {
  const jobs = [
    { slug: 'clean', cwd: '/proj-clean', status: 'completed' },
    { slug: 'running', cwd: '/proj-clean', status: 'running' },
    { slug: 'pending', cwd: '/proj-clean', status: 'pending' },
  ];
  assert.deepStrictEqual(computeQueueHealth(jobs), []);
});

test('gateOutcome values other than never_ran do not count', () => {
  const jobs = [
    { slug: 'a', cwd: '/proj', status: 'completed', gateOutcome: 'passed' },
    { slug: 'b', cwd: '/proj', status: 'failed', gateOutcome: 'failed' },
    { slug: 'c', cwd: '/proj', status: 'failed', gateOutcome: 'unknown' },
  ];
  assert.deepStrictEqual(computeQueueHealth(jobs), []);
});

test('empty/missing jobs array is handled without throwing', () => {
  assert.deepStrictEqual(computeQueueHealth([]), []);
  assert.deepStrictEqual(computeQueueHealth(undefined), []);
});

test('is a pure read: never mutates the input jobs array or its rows', () => {
  const jobs = [{ slug: 'a', cwd: '/proj', status: 'needs_review', gateOutcome: 'never_ran' }];
  const snapshot = JSON.parse(JSON.stringify(jobs));
  computeQueueHealth(jobs);
  assert.deepStrictEqual(jobs, snapshot);
});

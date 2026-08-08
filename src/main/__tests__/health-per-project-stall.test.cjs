/**
 * health-per-project-stall.test.cjs — per-project problem-count rollup and
 * per-project stall-past-threshold escalation for the scheduler_queue health
 * check. Covers the gap where a project holding ONLY failed/needs_review/
 * quarantined rows (0 running, 0 pending) never tripped evaluateTickLiveness
 * (which requires actual pending work) — the exact way the burrow project's
 * four quarantined PRDs went dark.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/health-per-project-stall.test.cjs
 */

'use strict';

// vitest, NOT node:test — see the sibling note in
// scheduler-stall-per-project.test.cjs. node:assert works inside vitest.
import { test } from 'vitest';
const assert = require('node:assert/strict');
const {
  computeProjectProblemCounts,
  evaluatePerProjectStall,
  TICK_STALL_THRESHOLD_MS,
} = require('../health.cjs');
const { computeStallSummary } = require('../scheduler.cjs');

test('computeProjectProblemCounts: breaks down failed/needs_review/quarantined by project, ignores healthy statuses', () => {
  const jobs = [
    { slug: 'a', cwd: '/burrow', status: 'quarantined' },
    { slug: 'b', cwd: '/burrow', status: 'quarantined' },
    { slug: 'c', cwd: '/burrow', status: 'quarantined' },
    { slug: 'd', cwd: '/burrow', status: 'quarantined' },
    { slug: 'e', cwd: '/other', status: 'failed' },
    { slug: 'f', cwd: '/other', status: 'needs_review' },
    { slug: 'g', cwd: '/other', status: 'running' },
    { slug: 'h', cwd: '/other', status: 'pending' },
    { slug: 'i', cwd: '/other', status: 'completed' },
  ];
  const counts = computeProjectProblemCounts(jobs);
  assert.deepStrictEqual(counts['/burrow'], { failed: 0, needs_review: 0, quarantined: 4 });
  assert.deepStrictEqual(counts['/other'], { failed: 1, needs_review: 1, quarantined: 0 });
});

test('evaluatePerProjectStall: fully-stalled project past threshold flags pastThreshold=true', () => {
  const state = {
    lastRunAt: new Date(Date.now() - (TICK_STALL_THRESHOLD_MS + 60_000)).toISOString(),
    paused: null,
    jobs: [
      { slug: 'a', cwd: '/burrow', status: 'quarantined' },
      { slug: 'b', cwd: '/other', status: 'running' },
    ],
    invalidJobs: [],
  };
  const summary = computeStallSummary(state);
  const result = evaluatePerProjectStall(summary, state.lastRunAt, Date.now(), TICK_STALL_THRESHOLD_MS);
  assert.strictEqual(result['/burrow'].stalled, true);
  assert.strictEqual(result['/burrow'].pastThreshold, true);
  assert.strictEqual(result['/other'].stalled, false);
});

test('evaluatePerProjectStall: stalled but NOT yet past threshold flags pastThreshold=false', () => {
  const state = {
    lastRunAt: new Date(Date.now() - 1000).toISOString(), // just ticked
    paused: null,
    jobs: [{ slug: 'a', cwd: '/burrow', status: 'quarantined' }],
    invalidJobs: [],
  };
  const summary = computeStallSummary(state);
  const result = evaluatePerProjectStall(summary, state.lastRunAt, Date.now(), TICK_STALL_THRESHOLD_MS);
  assert.strictEqual(result['/burrow'].stalled, true);
  assert.strictEqual(result['/burrow'].pastThreshold, false);
});

test('evaluatePerProjectStall: no lastRunAt yet — stalled but not asserted past threshold (caveat, not a false RED)', () => {
  const state = {
    lastRunAt: null,
    paused: null,
    jobs: [{ slug: 'a', cwd: '/burrow', status: 'quarantined' }],
    invalidJobs: [],
  };
  const summary = computeStallSummary(state);
  const result = evaluatePerProjectStall(summary, state.lastRunAt, Date.now(), TICK_STALL_THRESHOLD_MS);
  assert.strictEqual(result['/burrow'].stalled, true);
  assert.strictEqual(result['/burrow'].pastThreshold, false);
  assert.strictEqual(result['/burrow'].caveat, 'no-lastRunAt');
});

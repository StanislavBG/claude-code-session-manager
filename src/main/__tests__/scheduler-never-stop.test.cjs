/**
 * scheduler-never-stop.test.cjs — the invariant: if a queue holds ready PRDs,
 * something must drive them.
 *
 * Every stall observed in this codebase was a different CAUSE with the same
 * SHAPE — ready rows, nothing running, nobody ticking:
 *   - a rate-limited exit stamped terminal 'failed' (2026-09-05: 42 rows)
 *   - a spin loop past the manual-clear cooldown
 *   - a worktree merge-back leaving the project on a job branch
 *   - a job parked needs_review with no fix plan
 *   - app churn under session-manager-operations/ counted as unfinished work
 *   - the billing meter itself 429ing so utilization never reported
 * Guarding each cause individually always lags the next one, so the watchdog
 * guards the shape.
 *
 * Run: timeout 180 npx vitest run src/main/__tests__/scheduler-never-stop.test.cjs
 */

'use strict';

// vitest, NOT node:test — this repo's suite is vitest-only (CLAUDE.md).
import { test } from 'vitest';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// HOME before require: every state path is baked from os.homedir() at load.
process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'never-stop-test-'));

const {
  classifyQueueStarvation,
  QUEUE_STARVATION_MS,
  stripAppOwnedChurn,
} = require('../scheduler.cjs');

const CWD = '/home/bilko/Projects/starry-night-ships';
const NOW = Date.parse('2026-09-05T23:00:00.000Z');
const idleFor = (ms) => NOW - ms;
const LONG = QUEUE_STARVATION_MS + 60_000;

const base = (over = {}) => ({
  jobs: [{ slug: 'a', cwd: CWD, status: 'pending', dependsOn: [] }],
  paused: null,
  runningCount: 0,
  lastRunAtMs: idleFor(LONG),
  now: NOW,
  ...over,
});

// ── the invariant ────────────────────────────────────────────────────────────

test('ready work + nothing running + long idle => starved, and a tick would help', () => {
  const v = classifyQueueStarvation(base());
  assert.equal(v.kind, 'starved');
  assert.equal(v.pending, 1);
  assert.equal(v.dispatchable, 1);
});

test('the real incident shape: 40 ready rows, 0 running, idle for hours', () => {
  const jobs = Array.from({ length: 40 }, (_, i) => ({
    slug: `${207 + i}-step`, cwd: CWD, status: 'pending', dependsOn: [],
  }));
  const v = classifyQueueStarvation(base({ jobs, lastRunAtMs: idleFor(3 * 60 * 60_000) }));
  assert.equal(v.kind, 'starved');
  assert.equal(v.dispatchable, 40);
});

// ── it must NOT fire when the queue is legitimately quiet ────────────────────

test('a running job means the queue is flowing — never starved', () => {
  assert.equal(classifyQueueStarvation(base({ runningCount: 1 })), null);
});

test('no pending rows is not a stall', () => {
  assert.equal(classifyQueueStarvation(base({ jobs: [{ slug: 'a', cwd: CWD, status: 'completed' }] })), null);
});

test('paused is a DECISION, not a stall — the watchdog must never override it', () => {
  assert.equal(classifyQueueStarvation(base({ paused: { reason: 'rate_limit', resumeAt: null } })), null);
});

test('inside the idle threshold the normal path gets its chance first', () => {
  assert.equal(classifyQueueStarvation(base({ lastRunAtMs: idleFor(QUEUE_STARVATION_MS - 1000) })), null);
});

test('a never-recorded lastRunAt counts as infinitely idle, not as healthy', () => {
  const v = classifyQueueStarvation(base({ lastRunAtMs: NaN }));
  assert.equal(v.kind, 'starved');
});

// ── blocked is a DIFFERENT verdict from starved ──────────────────────────────

test('every pending row behind a terminal dep => blocked, not starved (a tick cannot help)', () => {
  const jobs = [
    { slug: '206-lava-ape', cwd: CWD, status: 'failed', dependsOn: [] },
    { slug: '207-body', cwd: CWD, status: 'pending', dependsOn: ['206-lava-ape'] },
    { slug: '208-docs', cwd: CWD, status: 'pending', dependsOn: ['207-body'] },
  ];
  const v = classifyQueueStarvation(base({ jobs }));
  assert.equal(v.kind, 'blocked');
  assert.equal(v.pending, 2);
  assert.equal(v.dispatchable, 0);
  assert.deepEqual(v.blockedChains[0].blockedBy, ['206-lava-ape']);
});

test('one dispatchable row among blocked ones still counts as starved — the queue can make progress', () => {
  const jobs = [
    { slug: 'x-dead', cwd: CWD, status: 'failed', dependsOn: [] },
    { slug: 'y-blocked', cwd: CWD, status: 'pending', dependsOn: ['x-dead'] },
    { slug: 'z-ready', cwd: CWD, status: 'pending', dependsOn: [] },
  ];
  const v = classifyQueueStarvation(base({ jobs }));
  assert.equal(v.kind, 'starved');
  assert.equal(v.dispatchable, 1);
});

test('a project blocked while ANOTHER project has ready work is still starved overall', () => {
  const jobs = [
    { slug: 'a-dead', cwd: '/p/one', status: 'failed', dependsOn: [] },
    { slug: 'b-blocked', cwd: '/p/one', status: 'pending', dependsOn: ['a-dead'] },
    { slug: 'c-ready', cwd: '/p/two', status: 'pending', dependsOn: [] },
  ];
  assert.equal(classifyQueueStarvation(base({ jobs })).kind, 'starved');
});

// ── app-owned churn must never be blamed on a job ────────────────────────────

test('stripAppOwnedChurn drops session-manager-operations churn, keeps real source', () => {
  const out = stripAppOwnedChurn([
    'src/main/scheduler.cjs',
    'session-manager-operations/scheduler/state/queue.json',
    'session-manager-operations/scheduler/state/history.jsonl',
    'session-manager-operations/prompt-sessions/active-index.json',
    'dashboard/panels/outcome-stats.jsx',
  ]);
  assert.deepEqual(out, ['src/main/scheduler.cjs', 'dashboard/panels/outcome-stats.jsx']);
});

test('stripAppOwnedChurn preserves the null contract (git status unavailable != left nothing)', () => {
  assert.equal(stripAppOwnedChurn(null), null);
  assert.equal(stripAppOwnedChurn(undefined), undefined);
});

test('stripAppOwnedChurn only matches a whole path segment, never a substring', () => {
  assert.deepEqual(
    stripAppOwnedChurn(['docs/session-manager-operations-guide.md', 'a/session-manager-operations/x.json']),
    ['docs/session-manager-operations-guide.md'],
  );
});

test('a job that leaves REAL source dirty still parks — the filter must not excuse that', () => {
  assert.deepEqual(
    stripAppOwnedChurn(['session-manager-operations/scheduler/state/queue.json', 'scripts/arena/titan.gd']),
    ['scripts/arena/titan.gd'],
  );
});

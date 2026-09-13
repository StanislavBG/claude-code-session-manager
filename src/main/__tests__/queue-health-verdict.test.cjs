/**
 * queue-health-verdict.test.cjs — classifyQueueHealth is the Scheduler
 * page's queue-health header: the single honest read of WHY a queue looks
 * stale (saturated slots / blocked dependencies / genuinely idle / the
 * dispatch driver itself stalled / a decision to pause / an open launch
 * circuit breaker), reusing classifyQueueStarvation so the header can never
 * disagree with the starvation watchdog's own read of the same state.
 *
 * Run: timeout 180 npx vitest run src/main/__tests__/queue-health-verdict.test.cjs
 */

'use strict';

import { test, afterAll } from 'vitest';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// HOME before require: every state path is baked from os.homedir() at load.
const originalHome = process.env.HOME;
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-health-test-'));
process.env.HOME = tmpHome;
fs.mkdirSync(path.join(tmpHome, '.claude', 'session-manager'), { recursive: true });
fs.mkdirSync(path.join(tmpHome, '.claude', 'projects'), { recursive: true });

const { classifyQueueHealth, QUEUE_STARVATION_MS } = require('../scheduler.cjs');

afterAll(() => {
  process.env.HOME = originalHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

const CWD = '/home/bilko/Projects/starry-night-ships';
const NOW = Date.parse('2026-09-13T20:00:00.000Z');
const LONG = QUEUE_STARVATION_MS + 60_000;

test('saturated: jobs running, zero free slots', () => {
  const jobs = [
    { slug: '1-a', cwd: CWD, status: 'running', startedAt: new Date(NOW - LONG).toISOString(), dependsOn: [] },
    { slug: '2-b', cwd: CWD, status: 'pending', dependsOn: [] },
  ];
  const v = classifyQueueHealth({
    jobs, paused: null, launchBlocks: {}, runningSet: new Set(['1-a']),
    freeSlots: 0, totalSlots: 4, lastDispatchAttemptAtMs: NOW, now: NOW, cwd: CWD,
  });
  assert.equal(v.kind, 'saturated');
  assert.equal(v.runningCount, 1);
  assert.equal(v.totalSlots, 4);
  // Dispatchable/blocked counts stay real numbers even in a kind whose
  // headline cause is slot saturation, not dependency shape — the header
  // must still be able to show them alongside the verdict.
  assert.equal(v.pending, 1);
  assert.equal(v.dispatchable, 1);
  assert.deepEqual(v.blockedChains, []);
});

test('blocked: every pending row terminates in a failed dependency', () => {
  const jobs = [
    { slug: '1-a', cwd: CWD, status: 'failed', dependsOn: [] },
    { slug: '2-b', cwd: CWD, status: 'pending', dependsOn: ['1-a'] },
  ];
  const v = classifyQueueHealth({
    jobs, paused: null, launchBlocks: {}, runningSet: new Set(),
    freeSlots: 4, totalSlots: 4, lastDispatchAttemptAtMs: NOW - 5_000, now: NOW, cwd: CWD,
  });
  assert.equal(v.kind, 'blocked');
  assert.equal(v.pending, 1);
  assert.equal(v.dispatchable, 0);
  assert.equal(v.blockedChains.length, 1);
  assert.deepEqual(v.blockedChains[0].blockedBy, ['1-a']);
});

test('idle: nothing pending', () => {
  const jobs = [
    { slug: '1-a', cwd: CWD, status: 'completed', dependsOn: [] },
  ];
  const v = classifyQueueHealth({
    jobs, paused: null, launchBlocks: {}, runningSet: new Set(),
    freeSlots: 4, totalSlots: 4, lastDispatchAttemptAtMs: NOW, now: NOW, cwd: CWD,
  });
  assert.equal(v.kind, 'idle');
  assert.equal(v.pending, 0);
  assert.equal(v.dispatchable, 0);
});

test('stalled: dispatchable work, nothing running, driver idle past threshold', () => {
  const jobs = [
    { slug: '1-a', cwd: CWD, status: 'pending', dependsOn: [] },
  ];
  const v = classifyQueueHealth({
    jobs, paused: null, launchBlocks: {}, runningSet: new Set(),
    freeSlots: 4, totalSlots: 4, lastDispatchAttemptAtMs: NOW - LONG, now: NOW, cwd: CWD,
  });
  assert.equal(v.kind, 'stalled');
  assert.equal(v.dispatchable, 1);
  assert.ok(v.idleMs >= QUEUE_STARVATION_MS);
});

test('running: dispatchable work, nothing running yet, but driver has not been idle long enough to call it a stall', () => {
  const jobs = [
    { slug: '1-a', cwd: CWD, status: 'pending', dependsOn: [] },
  ];
  const v = classifyQueueHealth({
    jobs, paused: null, launchBlocks: {}, runningSet: new Set(),
    freeSlots: 4, totalSlots: 4, lastDispatchAttemptAtMs: NOW - 5_000, now: NOW, cwd: CWD,
  });
  assert.equal(v.kind, 'running');
});

test('paused: a decision, not a stall — takes priority over everything else', () => {
  const jobs = [
    { slug: '1-a', cwd: CWD, status: 'pending', dependsOn: [] },
  ];
  const v = classifyQueueHealth({
    jobs, paused: { reason: 'manual', since: NOW }, launchBlocks: {}, runningSet: new Set(),
    freeSlots: 0, totalSlots: 4, lastDispatchAttemptAtMs: NOW - LONG, now: NOW, cwd: CWD,
  });
  assert.equal(v.kind, 'paused');
  assert.equal(v.reason, 'manual');
  assert.equal(v.pending, 1);
  assert.equal(v.dispatchable, 1);
});

test('launch-blocked: an open circuit breaker for a persona a pending row actually uses', () => {
  const jobs = [
    { slug: '1-a', cwd: CWD, status: 'pending', dependsOn: [], agentType: 'dev-lead' },
  ];
  const launchBlocks = {
    'dev-lead': { kind: 'model_config_rejected', attempts: 3, hint: 'update the CLI', until: null },
  };
  const v = classifyQueueHealth({
    jobs, paused: null, launchBlocks, runningSet: new Set(),
    freeSlots: 4, totalSlots: 4, lastDispatchAttemptAtMs: NOW - LONG, now: NOW, cwd: CWD,
  });
  assert.equal(v.kind, 'launch-blocked');
  assert.equal(v.agentType, 'dev-lead');
  assert.equal(v.pending, 1);
  assert.equal(v.dispatchable, 1);
});

test('launch-blocked is scoped: a breaker for a persona nothing pending here uses does not fire', () => {
  const jobs = [
    { slug: '1-a', cwd: CWD, status: 'pending', dependsOn: [], agentType: 'dev-lead' },
  ];
  const launchBlocks = {
    'architect': { kind: 'model_config_rejected', attempts: 3, hint: 'update the CLI', until: null },
  };
  const v = classifyQueueHealth({
    jobs, paused: null, launchBlocks, runningSet: new Set(),
    freeSlots: 4, totalSlots: 4, lastDispatchAttemptAtMs: NOW - 5_000, now: NOW, cwd: CWD,
  });
  assert.notEqual(v.kind, 'launch-blocked');
});

test('needsReviewCount and cwd scoping: another project\'s rows never leak into this scope\'s counts', () => {
  const other = '/home/bilko/Projects/session-manager';
  const jobs = [
    { slug: '1-a', cwd: CWD, status: 'needs_review', dependsOn: [] },
    { slug: '2-b', cwd: CWD, status: 'pending', dependsOn: [] },
    { slug: '3-c', cwd: other, status: 'pending', dependsOn: [] },
    { slug: '4-d', cwd: other, status: 'needs_review', dependsOn: [] },
  ];
  const v = classifyQueueHealth({
    jobs, paused: null, launchBlocks: {}, runningSet: new Set(),
    freeSlots: 4, totalSlots: 4, lastDispatchAttemptAtMs: NOW - 5_000, now: NOW, cwd: CWD,
  });
  assert.equal(v.pending, 1);
  assert.equal(v.needsReviewCount, 1);
});

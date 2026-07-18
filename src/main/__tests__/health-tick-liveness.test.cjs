/**
 * health-tick-liveness.test.cjs — tick-liveness assertion for the
 * scheduler_queue health check (PRD: health stayed GREEN through the
 * 2026-07-14 16.5h scheduler-tick stall while PRD 544 sat pending with free
 * capacity). Exercises evaluateTickLiveness()/readFreshHeartbeat() directly
 * since they're pure/fs-isolated — no need to mock os.homedir() through the
 * full check() to cover the liveness logic.
 *
 * Run: timeout 120 node --test src/main/__tests__/health-tick-liveness.test.cjs
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  evaluateTickLiveness,
  readFreshHeartbeat,
  TICK_STALL_THRESHOLD_MS,
} = require('../health.cjs');

// Real incident fixture, verified at triage (PRD notes): queue.json had one
// job pending, running:0, concurrencyCap:3, paused:null, enabled:true, and
// lastRunAt frozen at the moment the tick died.
const STALL_LAST_RUN_AT = '2026-07-14T14:40:39.274Z';
const NOW = Date.parse(STALL_LAST_RUN_AT) + 16.5 * 60 * 60_000; // 16.5h later

function baseQueue(overrides = {}) {
  return {
    config: {
      concurrencyCap: 3,
      firePolicy: 'when-available',
      utilizationThreshold: 90,
      enabled: true,
    },
    jobs: [
      { slug: '544-stuck-job', status: 'pending' },
    ],
    lastRunAt: STALL_LAST_RUN_AT,
    paused: null,
    ...overrides,
  };
}

test('reports stalled: pending job, free capacity, not paused, enabled, tick silent for 16.5h (heartbeat confirms utilization is not the explanation)', () => {
  const heartbeat = { ts: NOW - 30_000, utilization: 0 };
  const result = evaluateTickLiveness(baseQueue(), heartbeat, NOW);
  assert.strictEqual(result.stalled, true);
  assert.strictEqual(result.oldestPendingSlug, '544-stuck-job');
  assert.ok(result.tickAgeMs > TICK_STALL_THRESHOLD_MS);
});

test('no false positive: queue is paused (incl. rate-limit auto-pause)', () => {
  const result = evaluateTickLiveness(
    baseQueue({ paused: { reason: 'rate-limit', resumeAt: '2099-01-01T00:00:00.000Z' } }),
    null,
    NOW
  );
  assert.strictEqual(result.stalled, false);
  assert.strictEqual(result.reason, 'paused');
});

test('no false positive: running is already at concurrencyCap', () => {
  const q = baseQueue({
    jobs: [
      { slug: 'running-1', status: 'running' },
      { slug: 'running-2', status: 'running' },
      { slug: 'running-3', status: 'running' },
      { slug: '544-stuck-job', status: 'pending' },
    ],
  });
  const result = evaluateTickLiveness(q, null, NOW);
  assert.strictEqual(result.stalled, false);
  assert.strictEqual(result.reason, 'at-capacity');
});

test('no false positive: scheduler disabled', () => {
  const q = baseQueue({ config: { ...baseQueue().config, enabled: false } });
  const result = evaluateTickLiveness(q, null, NOW);
  assert.strictEqual(result.stalled, false);
  assert.strictEqual(result.reason, 'disabled');
});

test('no false positive: billing utilization at/above utilizationThreshold (when-available is designed to hold)', () => {
  const heartbeat = { ts: NOW - 30_000, utilization: 95 };
  const result = evaluateTickLiveness(baseQueue(), heartbeat, NOW);
  assert.strictEqual(result.stalled, false);
  assert.strictEqual(result.reason, 'utilization-at-threshold');
});

test('no false positive: no pending jobs at all', () => {
  const q = baseQueue({ jobs: [] });
  const result = evaluateTickLiveness(q, null, NOW);
  assert.strictEqual(result.stalled, false);
  assert.strictEqual(result.reason, 'no-pending-jobs');
});

test('degrades honestly: heartbeat missing/stale means utilization cannot be ruled out — caveat, not a confident stall', () => {
  const result = evaluateTickLiveness(baseQueue(), null, NOW);
  assert.strictEqual(result.stalled, false);
  assert.strictEqual(result.caveat, true);
  assert.strictEqual(result.reason, 'cannot-verify-utilization');
});

test('does not caveat when firePolicy is not when-available (utilization is irrelevant, so no heartbeat needed)', () => {
  const q = baseQueue({ config: { ...baseQueue().config, firePolicy: 'manual' } });
  const result = evaluateTickLiveness(q, null, NOW);
  assert.strictEqual(result.stalled, true);
});

test('readFreshHeartbeat: returns null for missing file', () => {
  const result = readFreshHeartbeat(path.join(os.tmpdir(), 'sm-health-test-nonexistent.log'));
  assert.strictEqual(result, null);
});

test('readFreshHeartbeat: returns null for a stale (old) heartbeat line', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-health-heartbeat-'));
  const p = path.join(dir, 'heartbeat.log');
  try {
    fs.writeFileSync(p, `${JSON.stringify({ ts: Date.now() - 60 * 60_000, utilization: 10 })}\n`);
    assert.strictEqual(readFreshHeartbeat(p), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readFreshHeartbeat: returns the parsed last line when fresh', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-health-heartbeat-'));
  const p = path.join(dir, 'heartbeat.log');
  try {
    fs.writeFileSync(
      p,
      `${JSON.stringify({ ts: Date.now() - 5 * 60_000, utilization: 10 })}\n${JSON.stringify({ ts: Date.now(), utilization: 42 })}\n`
    );
    const entry = readFreshHeartbeat(p);
    assert.strictEqual(entry.utilization, 42);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

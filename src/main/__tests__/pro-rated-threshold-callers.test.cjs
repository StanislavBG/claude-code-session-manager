'use strict';
/**
 * Pro-rated 'pause above' callers (PRD 4503): health's held check reads the
 * same pro-rated threshold as scheduler/utilizationHold.cjs, not the flat cap.
 */
import { test } from 'vitest';
const assert = require('node:assert/strict');
const { evaluateTickLiveness } = require('../health.cjs');
const { proRatedThreshold } = require('../scheduler/utilizationHold.cjs');

const DAY = 86_400_000;
const LAST_RUN = '2026-11-20T00:00:00.000Z';
const NOW = Date.parse(LAST_RUN) + 2 * 3_600_000; // tick silent 2 h

function queue() {
  return {
    config: { firePolicy: 'when-available', utilizationThreshold: 90, enabled: true },
    jobs: [{ slug: 'a-job', status: 'pending' }],
    lastRunAt: LAST_RUN,
    paused: null,
    slotCap: 3,
  };
}

function heartbeat(utilization, daysLeft) {
  return {
    ts: NOW - 30_000,
    utilization,
    utilizationWindow: 'weekly_all',
    nextReset: new Date(NOW + daysLeft * DAY).toISOString(),
  };
}

test('weekly_all 92% with 1.7 days left is not held (pro-rated cap is 99)', () => {
  const r = evaluateTickLiveness(queue(), heartbeat(92, 1.7), NOW);
  assert.notStrictEqual(r.reason, 'utilization-at-threshold');
  assert.strictEqual(r.stalled, true);
});

test('weekly_all 93% with 6 days left is held (effective cap about 91.8)', () => {
  const hb = heartbeat(93, 6);
  const cap = proRatedThreshold({ base: 90, window: hb.utilizationWindow, resetsAt: hb.nextReset, now: NOW });
  assert.ok(Math.abs(cap - 91.8) < 0.01, `cap ${cap}`);
  const r = evaluateTickLiveness(queue(), hb, NOW);
  assert.strictEqual(r.stalled, false);
  assert.strictEqual(r.reason, 'utilization-at-threshold');
});

test('weekly_all 91% with 6 days left is not held (below the pro-rated cap, above the flat base)', () => {
  const r = evaluateTickLiveness(queue(), heartbeat(91, 6), NOW);
  assert.strictEqual(r.stalled, true);
});

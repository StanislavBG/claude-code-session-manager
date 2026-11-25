'use strict';
/**
 * bindingWindowPauseThreshold (PRD 4532): the rate_limit pause's pro-rated
 * 'pause above' takes the window NAME from the same reading as the reset, so
 * a refreshed five_hour reading is never pro-rated against a cached weekly
 * window length.
 */
import { test } from 'vitest';
const assert = require('node:assert/strict');
const { __test, billingReadingForPause } = require('../scheduler.cjs');
const billing = require('../usage.cjs');

const { bindingWindowPauseThreshold } = __test;
const HOUR = 3_600_000;
const NOW = Date.parse('2026-11-24T12:00:00.000Z');

async function withUsage(limits, fn) {
  const original = billing.fetchUsage;
  billing.fetchUsage = async () => ({ kind: 'ok', data: { usage: { limits } } });
  try {
    return await fn();
  } finally {
    billing.fetchUsage = original;
  }
}

test('weekly_all reset 41 h ahead with base 90 -> 100', () => {
  const t = bindingWindowPauseThreshold(90, { window: 'weekly_all', resetsAt: new Date(NOW + 41 * HOUR).toISOString() }, NOW);
  assert.strictEqual(t, 100);
});

test('five_hour reset 4 h ahead with a weekly cached name -> the five-hour value (~92.8), not the weekly one', async () => {
  // Seed the cache with a weekly binding window.
  await withUsage(
    [{ kind: 'weekly_all', percent: 64, resets_at: new Date(NOW + 41 * HOUR).toISOString(), scope: null, is_active: true }],
    () => billingReadingForPause(),
  );
  const resetsAt = new Date(NOW + 4 * HOUR).toISOString();
  // Cached name alone (weekly) with this reset would pro-rate to 100.
  assert.strictEqual(bindingWindowPauseThreshold(90, { window: 'weekly_all', resetsAt }, NOW), 100);
  const t = bindingWindowPauseThreshold(90, { window: 'five_hour', resetsAt }, NOW);
  assert.ok(Math.abs(t - 92.8) < 0.01, `threshold ${t}`);
});

test('billingReadingForPause pairs the refreshed window name with its reset', async () => {
  await withUsage(
    [{ kind: 'weekly_all', percent: 64, resets_at: new Date(NOW + 41 * HOUR).toISOString(), scope: null, is_active: true }],
    () => billingReadingForPause(),
  );
  const resetsAt = new Date(NOW + 4 * HOUR).toISOString();
  const reading = await withUsage(
    [{ kind: 'five_hour', percent: 95, resets_at: resetsAt, scope: null, is_active: true }],
    () => billingReadingForPause(),
  );
  assert.deepStrictEqual(reading, { window: 'five_hour', resetsAt });
  const t = bindingWindowPauseThreshold(90, reading, NOW);
  assert.ok(Math.abs(t - 92.8) < 0.01, `threshold ${t}`);
});

test('no reading passed -> the cached pair', async () => {
  const resetsAt = new Date(NOW + 41 * HOUR).toISOString();
  await withUsage(
    [{ kind: 'weekly_all', percent: 64, resets_at: resetsAt, scope: null, is_active: true }],
    () => billingReadingForPause(),
  );
  assert.strictEqual(bindingWindowPauseThreshold(90, null, NOW), 100);
  assert.strictEqual(bindingWindowPauseThreshold('x', null, NOW), 'x');
});

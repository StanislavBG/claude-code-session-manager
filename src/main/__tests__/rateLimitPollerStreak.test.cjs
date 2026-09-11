/**
 * rateLimitPollerStreak.test.cjs — covers the fix for the silent
 * consecutiveFailures streak on the usage/rate-limit poller (scheduler.cjs
 * pollLoop): the 'meter_rate_limited' branch used to never back off and
 * never call persistSchedulerState(), letting scheduler-state.json freeze
 * stale while the loop kept failing every POLL_INTERVAL_MS underneath it.
 * This suite covers the two pure pieces of the fix: the shared backoff
 * curve/cap (nextBackoffMs) and the once-per-streak WARN gate
 * (shouldWarnFailureStreak).
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/rateLimitPollerStreak.test.cjs
 */

'use strict';

import { test, expect } from 'vitest';
const {
  nextBackoffMs,
  shouldWarnFailureStreak,
  BACKOFF_MAX_MS,
  FAILURE_STREAK_WARN_THRESHOLD,
} = require('../scheduler.cjs');

test('nextBackoffMs starts at 30s from a zero/falsy backoff', () => {
  expect(nextBackoffMs(0)).toBe(30_000);
  expect(nextBackoffMs(null)).toBe(30_000);
});

test('nextBackoffMs doubles each call', () => {
  let ms = 0;
  ms = nextBackoffMs(ms); // 30_000
  ms = nextBackoffMs(ms); // 60_000
  ms = nextBackoffMs(ms); // 120_000
  expect(ms).toBe(120_000);
});

test('nextBackoffMs caps at BACKOFF_MAX_MS (8 minutes) and never exceeds it', () => {
  let ms = 0;
  for (let i = 0; i < 20; i++) ms = nextBackoffMs(ms);
  expect(ms).toBe(BACKOFF_MAX_MS);
  expect(BACKOFF_MAX_MS).toBe(480_000);
  // One more doubling from an already-capped value must still be capped, not climb further.
  expect(nextBackoffMs(ms)).toBe(BACKOFF_MAX_MS);
});

test('shouldWarnFailureStreak is false below the threshold', () => {
  expect(shouldWarnFailureStreak(1, false)).toBe(false);
  expect(shouldWarnFailureStreak(FAILURE_STREAK_WARN_THRESHOLD - 1, false)).toBe(false);
});

test('shouldWarnFailureStreak fires exactly once when the threshold is crossed', () => {
  expect(shouldWarnFailureStreak(FAILURE_STREAK_WARN_THRESHOLD, false)).toBe(true);
});

test('shouldWarnFailureStreak does not spam on every subsequent failure in the same streak', () => {
  // Simulate a 57-failure streak: warn fires once, then `alreadyWarned` stays
  // true for every remaining failure — this is the no-repeat property.
  let warned = false;
  let warnCount = 0;
  for (let failures = 1; failures <= 57; failures++) {
    if (shouldWarnFailureStreak(failures, warned)) {
      warned = true;
      warnCount++;
    }
  }
  expect(warnCount).toBe(1);
  expect(warned).toBe(true);
});

test('shouldWarnFailureStreak re-arms after a streak resets (alreadyWarned back to false)', () => {
  expect(shouldWarnFailureStreak(FAILURE_STREAK_WARN_THRESHOLD, false)).toBe(true);
  // A later, independent streak crossing the threshold again must warn again.
  expect(shouldWarnFailureStreak(FAILURE_STREAK_WARN_THRESHOLD, false)).toBe(true);
});

test('shouldWarnFailureStreak respects a custom threshold', () => {
  expect(shouldWarnFailureStreak(3, false, 3)).toBe(true);
  expect(shouldWarnFailureStreak(2, false, 3)).toBe(false);
});

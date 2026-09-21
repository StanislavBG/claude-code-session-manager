/**
 * rateLimitPollerStreak.test.cjs — covers the fix for the silent
 * consecutiveFailures streak on the usage/rate-limit poller (scheduler.cjs
 * pollLoop): the 'meter_rate_limited' branch used to never back off and
 * never call persistSchedulerState(), letting scheduler-state.json freeze
 * stale while the loop kept failing every POLL_INTERVAL_MS underneath it.
 * This suite covers the pure pieces of the fix: the shared backoff
 * curve/cap (nextBackoffMs), the once-per-streak WARN gate
 * (shouldWarnFailureStreak), and the periodic escalation ladder that fires
 * every FAILURE_STREAK_ESCALATION_MS while a streak PERSISTS past the
 * initial WARN, re-arming once the streak clears (shouldEscalateFailureStreak).
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/rateLimitPollerStreak.test.cjs
 */

'use strict';

import { test, expect } from 'vitest';
const {
  nextBackoffMs,
  shouldWarnFailureStreak,
  shouldEscalateFailureStreak,
  restoreFailureStreakWarnedAt,
  persistedStreakMinutes,
  BACKOFF_MAX_MS,
  FAILURE_STREAK_WARN_THRESHOLD,
  FAILURE_STREAK_ESCALATION_MS,
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

test('shouldEscalateFailureStreak: false below the WARN threshold, regardless of elapsed time', () => {
  expect(shouldEscalateFailureStreak(FAILURE_STREAK_WARN_THRESHOLD - 1, null, Date.now())).toBe(false);
});

test('shouldEscalateFailureStreak: fires immediately the first time (lastEscalatedAtMs null) once past the WARN threshold', () => {
  expect(shouldEscalateFailureStreak(FAILURE_STREAK_WARN_THRESHOLD, null, Date.now())).toBe(true);
});

test('shouldEscalateFailureStreak: does not re-fire before FAILURE_STREAK_ESCALATION_MS has elapsed since the last one', () => {
  const lastEscalatedAtMs = 1_000_000;
  const tooSoon = lastEscalatedAtMs + FAILURE_STREAK_ESCALATION_MS - 1;
  expect(shouldEscalateFailureStreak(FAILURE_STREAK_WARN_THRESHOLD, lastEscalatedAtMs, tooSoon)).toBe(false);
});

test('shouldEscalateFailureStreak: fires again once FAILURE_STREAK_ESCALATION_MS has elapsed — the persisting-streak ladder', () => {
  const lastEscalatedAtMs = 1_000_000;
  const dueNow = lastEscalatedAtMs + FAILURE_STREAK_ESCALATION_MS;
  expect(shouldEscalateFailureStreak(FAILURE_STREAK_WARN_THRESHOLD, lastEscalatedAtMs, dueNow)).toBe(true);
});

test('shouldEscalateFailureStreak: re-arms after a streak clears (lastEscalatedAtMs reset to null) — a later independent streak escalates again', () => {
  const firstStreakNow = 1_000_000;
  expect(shouldEscalateFailureStreak(FAILURE_STREAK_WARN_THRESHOLD, null, firstStreakNow)).toBe(true);
  // Streak clears (a success resets both failureStreakWarned and the
  // escalation timestamp) — a LATER, independent streak crossing the WARN
  // threshold again must escalate again immediately, not wait out a stale
  // 30-minute window from the previous incident.
  const laterStreakNow = firstStreakNow + 5 * 60_000; // well under 30 min later
  expect(shouldEscalateFailureStreak(FAILURE_STREAK_WARN_THRESHOLD, null, laterStreakNow)).toBe(true);
});

test('restoreFailureStreakWarnedAt backfills now when warned=true has no numeric timestamp', () => {
  expect(restoreFailureStreakWarnedAt(true, null, 5000)).toBe(5000);
  expect(restoreFailureStreakWarnedAt(true, 1000, 5000)).toBe(1000);
  expect(restoreFailureStreakWarnedAt(false, null, 5000)).toBeNull();
});

test('persistedStreakMinutes is always a number, never null', () => {
  expect(persistedStreakMinutes(null, 5000)).toBe(0);
  expect(persistedStreakMinutes(0, 120_000)).toBe(2);
  expect(persistedStreakMinutes(restoreFailureStreakWarnedAt(true, undefined, 5000), 5000)).toBe(0);
});

/**
 * scheduler-rate-limit-cooldown-freshness.test.cjs — PRD 1119.
 *
 * setPaused()'s manual-override cooldown used to suppress WRITING any pause
 * for 5 minutes after a human Resume/Run now, unconditionally — even when
 * the triggering rate-limit observation came from a run that started AFTER
 * the manual clear (i.e. brand-new evidence, not the stale auto-detection
 * the cooldown exists to ignore). Combined with the halt-reset that resets a
 * rate-limited job straight back to 'pending', this produced a hot dispatch
 * loop: dispatch -> 429 in seconds -> reset to pending -> pause suppressed
 * -> dispatch again, on a ~12s cadence, until the cooldown itself expired.
 *
 * isCooldownSuppressed() is the pure predicate this PRD extracts so both
 * directions of the fix (fresh observation bypasses the cooldown; stale one
 * stays suppressed) are directly unit-testable without touching queue.json,
 * mutate(), or any fs state. nextRapidRateLimitCount() is the pure reducer
 * behind the independent rapid-repeat hard-pause cap (a second circuit
 * breaker for when the computed resumeAt is itself stale/wrong and would
 * otherwise let the resume timer keep re-clearing the pause every ~30s,
 * with every subsequent dispatch genuinely "fresh").
 *
 * Run: timeout 60 npx vitest run src/main/__tests__/scheduler-rate-limit-cooldown-freshness.test.cjs
 */

'use strict';

import { test, expect } from 'vitest';
const {
  isCooldownSuppressed,
  nextRapidRateLimitCount,
  CONSECUTIVE_RAPID_RATE_LIMIT_THRESHOLD,
  RAPID_RATE_LIMIT_WINDOW_MS,
  MANUAL_PAUSE_COOLDOWN_MS,
} = require('../scheduler.cjs');

const clearedAt = 1_000_000;

test('a rate_limit pause triggered by a run that STARTED AFTER the manual clear engages regardless of the cooldown', () => {
  const now = clearedAt + 60_000; // well inside the 5-minute cooldown window
  const observedAt = clearedAt + 5_000; // the triggering run started after the clear
  const suppressed = isCooldownSuppressed({ pauseClearedManuallyAt: clearedAt, now, observedAt, force: false });
  expect(suppressed).toBe(false);
});

test('a rate_limit pause triggered by an observation OLDER than the manual clear stays suppressed', () => {
  const now = clearedAt + 60_000;
  const observedAt = clearedAt - 5_000; // stale: this run started before the human cleared the pause
  const suppressed = isCooldownSuppressed({ pauseClearedManuallyAt: clearedAt, now, observedAt, force: false });
  expect(suppressed).toBe(true);
});

test('no observedAt at all (unrelated pause reasons, e.g. auth/network) is treated as stale — unchanged prior behavior', () => {
  const now = clearedAt + 60_000;
  const suppressed = isCooldownSuppressed({ pauseClearedManuallyAt: clearedAt, now, observedAt: null, force: false });
  expect(suppressed).toBe(true);
});

test('once the cooldown window itself has elapsed, suppression lifts regardless of freshness', () => {
  const now = clearedAt + MANUAL_PAUSE_COOLDOWN_MS + 1;
  const suppressed = isCooldownSuppressed({ pauseClearedManuallyAt: clearedAt, now, observedAt: null, force: false });
  expect(suppressed).toBe(false);
});

test('no manual clear on record never suppresses', () => {
  const suppressed = isCooldownSuppressed({ pauseClearedManuallyAt: null, now: Date.now(), observedAt: null, force: false });
  expect(suppressed).toBe(false);
});

test('force always bypasses the cooldown, fresh or not', () => {
  const now = clearedAt + 1_000;
  const staleObservedAt = clearedAt - 5_000;
  const suppressed = isCooldownSuppressed({ pauseClearedManuallyAt: clearedAt, now, observedAt: staleObservedAt, force: true });
  expect(suppressed).toBe(false);
});

// ---------- rapid-repeat consecutive counter ----------

test('a rate-limited run under the rapid window increments the counter', () => {
  expect(nextRapidRateLimitCount(0, { rateLimited: true, durationMs: 4_000 })).toBe(1);
  expect(nextRapidRateLimitCount(1, { rateLimited: true, durationMs: 4_000 })).toBe(2);
});

test('a rate-limited run that ran for >= the rapid window does not increment the counter', () => {
  expect(nextRapidRateLimitCount(1, { rateLimited: true, durationMs: RAPID_RATE_LIMIT_WINDOW_MS })).toBe(1);
});

test('any non-rate-limited outcome resets the counter to 0', () => {
  expect(nextRapidRateLimitCount(2, { rateLimited: false, durationMs: 999_999 })).toBe(0);
});

test('driving the counter to the documented threshold engages the hard-pause condition', () => {
  let count = 0;
  for (let i = 0; i < CONSECUTIVE_RAPID_RATE_LIMIT_THRESHOLD; i += 1) {
    count = nextRapidRateLimitCount(count, { rateLimited: true, durationMs: 3_000 });
  }
  expect(count).toBe(CONSECUTIVE_RAPID_RATE_LIMIT_THRESHOLD);
  expect(count >= CONSECUTIVE_RAPID_RATE_LIMIT_THRESHOLD).toBe(true);
});

test('reaching the threshold forces the pause through even against a STALE observation still inside the cooldown window', () => {
  // This is the scenario the hard cap exists for: freshness alone is not
  // enough when the computed resumeAt is itself stale/wrong and the resume
  // timer keeps re-clearing the pause, so a LATER dispatch's observation can
  // legitimately look "stale" relative to the most recent clear. The
  // rapid-repeat counter is an independent, unconditional circuit breaker.
  let count = 0;
  for (let i = 0; i < CONSECUTIVE_RAPID_RATE_LIMIT_THRESHOLD; i += 1) {
    count = nextRapidRateLimitCount(count, { rateLimited: true, durationMs: 3_000 });
  }
  const force = count >= CONSECUTIVE_RAPID_RATE_LIMIT_THRESHOLD;
  const staleObservedAt = clearedAt - 999_999;
  const suppressed = isCooldownSuppressed({ pauseClearedManuallyAt: clearedAt, now: clearedAt + 1_000, observedAt: staleObservedAt, force });
  expect(suppressed).toBe(false);
});

test('one non-rate-limited run in between resets the streak so the hard pause never engages', () => {
  let count = 0;
  count = nextRapidRateLimitCount(count, { rateLimited: true, durationMs: 3_000 });
  count = nextRapidRateLimitCount(count, { rateLimited: true, durationMs: 3_000 });
  count = nextRapidRateLimitCount(count, { rateLimited: false, durationMs: 60_000 }); // job actually ran fine
  count = nextRapidRateLimitCount(count, { rateLimited: true, durationMs: 3_000 });
  expect(count).toBeLessThan(CONSECUTIVE_RAPID_RATE_LIMIT_THRESHOLD);
});

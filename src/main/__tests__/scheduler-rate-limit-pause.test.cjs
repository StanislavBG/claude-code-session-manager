/**
 * scheduler-rate-limit-pause.test.cjs — PRD 1118: pause against the BINDING
 * rate-limit window read off a run's own log, not refreshNextReset()'s
 * five_hour-only assumption, and never leave an indefinite pause with no
 * resume timer when both the log and the billing endpoint come up empty
 * (the live failure mode: the usage endpoint itself 429s).
 *
 * Also (usage-meter circuit PRD): neither function may arm a PAST reset —
 * resolveRateLimitPauseReset/computeEffectiveResumeAt now reject a stale ISO
 * via usageCircuit.isResetFresh and fall back to the bounded 30-MINUTE pause
 * instead. A stale reset used to survive straight into computeResumeDelay's
 * `Math.max(30_000, <negative>)`, arming a 30-SECOND nap that spun the queue
 * right back into the same still-active rate limit.
 *
 * These test the PURE decision functions scheduler.cjs's setPaused() and the
 * spawnJob() rateLimited branch delegate to — never the real setPaused/mutate
 * path, which writes the machine's live scheduler queue.json at a fixed
 * homedir path (~/.claude/session-manager/scheduled-plans) and must not be
 * touched by a test run.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/scheduler-rate-limit-pause.test.cjs
 */

'use strict';

import { test } from 'vitest';
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  resolveRateLimitPauseReset,
  billingResetForPause,
  computeEffectiveResumeAt,
  computeResumeDelay,
} = require('../scheduler.cjs');
const billing = require('../usage.cjs');

// Repo-tracked, byte-for-byte copy of the real 2026-09-05 starry-night-ships
// incident log (see src/main/lib/__tests__/rateLimitWindow.test.cjs for the
// live-path parity check) — kept hermetic rather than pointed at the
// machine-local live path directly.
const FIXTURE = path.join(__dirname, '..', 'lib', '__tests__', 'fixtures', '204-mercury-steam-horse.log.txt');
const FIVE_HOUR_ISO = new Date(1788643800 * 1000).toISOString(); // what refreshNextReset() would have returned
const SEVEN_DAY_ISO = new Date(1789059600 * 1000).toISOString(); // the actually-binding window
// Fixed "now" contemporaneous with the fixture's own timestamps (BEFORE both
// resets above), so freshness checks read the fixture the way it looked at
// incident time — not relative to whenever this suite happens to run.
const FIXTURE_NOW = Date.parse('2026-09-05T16:32:00.000Z');

test('resolveRateLimitPauseReset: prefers the log-derived seven-day reset over the billing five_hour reset', () => {
  const resetIso = resolveRateLimitPauseReset(FIXTURE, FIVE_HOUR_ISO, FIXTURE_NOW);
  assert.strictEqual(resetIso, SEVEN_DAY_ISO);
  assert.notStrictEqual(resetIso, FIVE_HOUR_ISO);
});

test('resolveRateLimitPauseReset: falls back to the billing reset when the log yields none', () => {
  const resetIso = resolveRateLimitPauseReset('/nonexistent/path/job.log', FIVE_HOUR_ISO, FIXTURE_NOW);
  assert.strictEqual(resetIso, FIVE_HOUR_ISO);
});

test('resolveRateLimitPauseReset: null when BOTH the log and the billing endpoint are unavailable', () => {
  assert.strictEqual(resolveRateLimitPauseReset('/nonexistent/path/job.log', null, FIXTURE_NOW), null);
});

test('resolveRateLimitPauseReset: a PAST log-derived reset is rejected, not returned stale', () => {
  // "now" is AFTER both fixture resets have already elapsed.
  const longAfter = Date.parse('2026-09-15T00:00:00.000Z');
  const resetIso = resolveRateLimitPauseReset(FIXTURE, FIVE_HOUR_ISO, longAfter);
  assert.strictEqual(resetIso, null);
});

test('resolveRateLimitPauseReset: log yields nothing and the billing reset has already passed -> null, not the stale value', () => {
  const longAfter = Date.parse('2026-09-15T00:00:00.000Z');
  const resetIso = resolveRateLimitPauseReset('/nonexistent/path/job.log', FIVE_HOUR_ISO, longAfter);
  assert.strictEqual(resetIso, null);
});

test('computeEffectiveResumeAt: rate_limit with no resumeAt gets the same bounded 30-minute fallback as network', () => {
  const now = FIXTURE_NOW;
  const resumeAt = computeEffectiveResumeAt('rate_limit', null, now);
  assert.strictEqual(resumeAt, new Date(now + 30 * 60_000).toISOString());
});

test('computeEffectiveResumeAt: a FRESH explicit resumeAt (the log-derived reset) is never overridden', () => {
  const resumeAt = computeEffectiveResumeAt('rate_limit', SEVEN_DAY_ISO, FIXTURE_NOW);
  assert.strictEqual(resumeAt, SEVEN_DAY_ISO);
});

test('computeEffectiveResumeAt: a PAST resumeAt gets the 30-minute fallback, not a ~30-second nap', () => {
  // now is well AFTER SEVEN_DAY_ISO has already elapsed — the exact shape of
  // the bug: Math.max(30_000, <negative>) used to arm a 30-second resume.
  const longAfter = Date.parse('2026-09-15T00:00:00.000Z');
  const resumeAt = computeEffectiveResumeAt('rate_limit', SEVEN_DAY_ISO, longAfter);
  assert.strictEqual(resumeAt, new Date(longAfter + 30 * 60_000).toISOString());
  assert.notStrictEqual(resumeAt, SEVEN_DAY_ISO);
  const { delayMs } = computeResumeDelay(resumeAt, longAfter);
  assert.ok(delayMs >= 30 * 60_000, `expected >= 30 minutes, got ${delayMs}ms`);
});

test('computeEffectiveResumeAt: other reasons (e.g. auth) get no fallback — stays indefinite', () => {
  assert.strictEqual(computeEffectiveResumeAt('auth', null, Date.now()), null);
});

test('billingResetForPause: skips refreshNextReset() (no billing.fetchUsage call) while the shared circuit is OPEN', async () => {
  const originalFetchUsage = billing.fetchUsage;
  let fetchCalls = 0;
  billing.fetchUsage = async () => { fetchCalls++; return { kind: 'ok', data: { usage: {} } }; };
  try {
    // Force the shared circuit open (3 consecutive failures), same threshold usageCircuit.cjs uses.
    billing.usageCircuit.recordFailure('a');
    billing.usageCircuit.recordFailure('a');
    billing.usageCircuit.recordFailure('a');
    assert.strictEqual(billing.usageCircuit.state(), 'open');

    await billingResetForPause();
    assert.strictEqual(fetchCalls, 0, 'refreshNextReset() must not call billing.fetchUsage() while the circuit is open');
  } finally {
    billing.usageCircuit.recordSuccess({}); // close the shared circuit back up for later tests/files
    billing.fetchUsage = originalFetchUsage;
  }
});

test('computeResumeDelay: a seven-day-out reset (~5 days from now) is armed, not treated as too-far', () => {
  const now = Date.parse('2026-09-05T16:32:00.000Z');
  // ~5 days out — comfortably under the 0x7fffffff (~24.8 day) setTimeout cap.
  const fiveDaysOut = new Date(now + 5 * 24 * 60 * 60_000).toISOString();
  const { delayMs, tooFar } = computeResumeDelay(fiveDaysOut, now);
  assert.strictEqual(tooFar, false);
  assert.ok(delayMs < 0x7fffffff, `expected delay under setTimeout cap, got ${delayMs}`);
  assert.ok(delayMs > 400_000_000, `expected ~5 days in ms, got ${delayMs}`);
});

test('computeResumeDelay: a reset far enough out DOES trip the overflow guard', () => {
  const now = Date.parse('2026-09-05T16:32:00.000Z');
  const thirtyDaysOut = new Date(now + 30 * 24 * 60 * 60_000).toISOString();
  const { tooFar } = computeResumeDelay(thirtyDaysOut, now);
  assert.strictEqual(tooFar, true);
});

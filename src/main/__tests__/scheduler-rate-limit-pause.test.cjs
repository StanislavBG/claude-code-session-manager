/**
 * scheduler-rate-limit-pause.test.cjs — PRD 1118: pause against the BINDING
 * rate-limit window read off a run's own log, not refreshNextReset()'s
 * five_hour-only assumption, and never leave an indefinite pause with no
 * resume timer when both the log and the billing endpoint come up empty
 * (the live failure mode: the usage endpoint itself 429s).
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
  computeEffectiveResumeAt,
  computeResumeDelay,
} = require('../scheduler.cjs');

// Repo-tracked, byte-for-byte copy of the real 2026-09-05 starry-night-ships
// incident log (see src/main/lib/__tests__/rateLimitWindow.test.cjs for the
// live-path parity check) — kept hermetic rather than pointed at the
// machine-local live path directly.
const FIXTURE = path.join(__dirname, '..', 'lib', '__tests__', 'fixtures', '204-mercury-steam-horse.log.txt');
const FIVE_HOUR_ISO = new Date(1788643800 * 1000).toISOString(); // what refreshNextReset() would have returned
const SEVEN_DAY_ISO = new Date(1789059600 * 1000).toISOString(); // the actually-binding window

test('resolveRateLimitPauseReset: prefers the log-derived seven-day reset over the billing five_hour reset', () => {
  const resetIso = resolveRateLimitPauseReset(FIXTURE, FIVE_HOUR_ISO);
  assert.strictEqual(resetIso, SEVEN_DAY_ISO);
  assert.notStrictEqual(resetIso, FIVE_HOUR_ISO);
});

test('resolveRateLimitPauseReset: falls back to the billing reset when the log yields none', () => {
  const resetIso = resolveRateLimitPauseReset('/nonexistent/path/job.log', FIVE_HOUR_ISO);
  assert.strictEqual(resetIso, FIVE_HOUR_ISO);
});

test('resolveRateLimitPauseReset: null when BOTH the log and the billing endpoint are unavailable', () => {
  assert.strictEqual(resolveRateLimitPauseReset('/nonexistent/path/job.log', null), null);
});

test('computeEffectiveResumeAt: rate_limit with no resumeAt gets the same bounded 30-minute fallback as network', () => {
  const now = Date.parse('2026-09-05T16:32:00.000Z');
  const resumeAt = computeEffectiveResumeAt('rate_limit', null, now);
  assert.strictEqual(resumeAt, new Date(now + 30 * 60_000).toISOString());
});

test('computeEffectiveResumeAt: an explicit resumeAt (the log-derived reset) is never overridden', () => {
  const resumeAt = computeEffectiveResumeAt('rate_limit', SEVEN_DAY_ISO, Date.now());
  assert.strictEqual(resumeAt, SEVEN_DAY_ISO);
});

test('computeEffectiveResumeAt: other reasons (e.g. auth) get no fallback — stays indefinite', () => {
  assert.strictEqual(computeEffectiveResumeAt('auth', null, Date.now()), null);
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

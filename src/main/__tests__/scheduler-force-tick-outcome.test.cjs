/**
 * scheduler-force-tick-outcome.test.cjs — unit tests for forceTickOutcome().
 *
 * Covers the "No pending jobs" vs "Already running" ambiguity: when
 * pickNextBatch() returns an empty batch with no hold reason, that's only
 * genuinely "no pending jobs" if nothing is running either — if a job
 * already transitioned to running (e.g. the when-available poll won a race
 * against a manual force-tick click), the message must say so instead of
 * flatly claiming nothing is pending.
 *
 * Run: timeout 120 node --test src/main/__tests__/scheduler-force-tick-outcome.test.cjs
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { forceTickOutcome } = require('../scheduler.cjs');

test('forceTickOutcome: null result → No pending jobs', () => {
  const outcome = forceTickOutcome(null);
  assert.strictEqual(outcome.message, 'No pending jobs');
});

test('forceTickOutcome: fired → Fired N job(s)', () => {
  const outcome = forceTickOutcome({ fired: true, count: 2, group: 0 });
  assert.strictEqual(outcome.message, 'Fired 2 job(s) (group g0)');
});

test('forceTickOutcome: reason=drained (genuinely nothing pending or running) → No pending jobs', () => {
  const outcome = forceTickOutcome({ fired: false, reason: 'drained' });
  assert.strictEqual(outcome.message, 'No pending jobs');
});

test('forceTickOutcome: reason=already-running (race: poll fired it first) → Already running message, not "No pending jobs"', () => {
  const outcome = forceTickOutcome({ fired: false, reason: 'already-running', runningCount: 1 });
  assert.strictEqual(outcome.message, 'Already running — 1 job(s) in flight');
  assert.notStrictEqual(outcome.message, 'No pending jobs');
});

test('forceTickOutcome: reason=held → detail message surfaces', () => {
  const outcome = forceTickOutcome({ fired: false, reason: 'held', detail: '[scheduler] concurrency [/a]: cap reached, no slots' });
  assert.strictEqual(outcome.message, 'cap reached, no slots');
});

console.log('scheduler-force-tick-outcome tests: PASS');

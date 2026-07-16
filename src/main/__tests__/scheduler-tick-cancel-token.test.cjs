/**
 * scheduler-tick-cancel-token.test.cjs — regression test for the 2026-07-14
 * scheduler stall (PRD 543/544): the tick loop stopped picking up pending
 * jobs after a job's run paused the queue (e.g. a rate limit), because the
 * pause's cancelToken.cancelled flag was only ever reset inside
 * runDueJobs() — clearPause() (used by the poll-loop's auth/network
 * auto-recovery and the manual "Resume" button) never reset it, so every
 * subsequent tickQueue() call short-circuited on the stale flag forever,
 * even though queue.json's `paused` field was correctly null.
 *
 * Run: timeout 120 node --test src/main/__tests__/scheduler-tick-cancel-token.test.cjs
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { applyPauseCleared, pickNextBatch } = require('../scheduler.cjs');

test('clearPause un-cancels the tick guard so the next pending job still starts', () => {
  // A job's run pauses the queue (e.g. rate limit) — setPaused() cancels the
  // in-flight tick batch.
  const cancelToken = { cancelled: true };

  // The pause is cleared via a recovery path OTHER than runDueJobs() (the
  // poll-loop's auth/network auto-recovery, or the manual "Resume" button —
  // both call clearPause() directly). Before the fix, this left
  // cancelToken.cancelled stuck at true forever.
  applyPauseCleared(true, cancelToken);

  assert.strictEqual(
    cancelToken.cancelled,
    false,
    'clearPause must un-cancel the tick guard, or every future tick short-circuits forever even though paused=null',
  );

  // With the guard cleared, the next tick's batch-picking proceeds normally
  // and starts the next pending job after the failed one.
  const jobs = [
    { slug: '543-chat-mode-data-table-rendering', status: 'failed', cwd: '/proj' },
    { slug: '544-committed-in-window-test-runner-consistency', status: 'pending', cwd: '/proj' },
  ];
  const { batch } = pickNextBatch(jobs, new Set(), 3);
  assert.strictEqual(batch.length, 1);
  assert.strictEqual(batch[0].slug, '544-committed-in-window-test-runner-consistency');
});

test('applyPauseCleared is a no-op when the queue was not actually paused', () => {
  const cancelToken = { cancelled: false };
  applyPauseCleared(false, cancelToken);
  assert.strictEqual(cancelToken.cancelled, false);
});

console.log('scheduler-tick-cancel-token tests: PASS');

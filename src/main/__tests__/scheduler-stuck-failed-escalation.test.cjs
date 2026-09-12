/**
 * scheduler-stuck-failed-escalation.test.cjs
 *
 * `failed` is a fully terminal state for every automated recovery path in
 * scheduler.cjs (selectResumeRecoveryTarget/selectAutoFixTargets require
 * needs_review, reapDeadRunningJobs only ever writes running → failed,
 * reconcile-repair's to-pending is for structurally invalid rows) — only a
 * human's scheduler_reset_job ever takes failed → pending. Job
 * 4056-outcome-stats sat `failed` for five days with no operator signal
 * (reported 2026-09-10, social-signals-trader), even once the periodic
 * reverify guard fix (shouldRunPeriodicReverify, commit f4125f8) made the
 * pass actually fire on it — reverifyNeedsReview's failed branch can only
 * annotate looksDone, never resolve a failed row.
 *
 * These tests cover findStuckFailedJobs (the escalation candidate finder) and
 * stuckFailedEscalationDisabled (the kill switch gate) in isolation.
 *
 * HOME is overridden to a tmp dir BEFORE requiring scheduler.cjs — see
 * scheduler-reap-dead-running-jobs.test.cjs's comment for why.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/scheduler-stuck-failed-escalation.test.cjs
 */

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'stuck-failed-escalation-test-'));
process.env.HOME = tmpHome;

const {
  findStuckFailedJobs,
  STUCK_FAILED_ESCALATE_MS,
  stuckFailedEscalationDisabled,
  isRescanCandidate,
} = require('../scheduler.cjs');

function writeRunLog(runId, slug, lines) {
  const runDir = path.join(tmpHome, '.claude', 'session-manager', 'scheduled-plans', 'runs', runId);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, `${slug}.log`), lines.join('\n') + '\n');
}

const DAY_MS = 24 * 60 * 60_000;

test('a failed rescan-candidate older than the threshold is reported exactly once', () => {
  writeRunLog('run-4056', '4056-outcome-stats', ['[scheduler] starting 4056-outcome-stats']); // no result event
  const now = Date.now();
  const job = {
    slug: '4056-outcome-stats',
    status: 'failed',
    cwd: '/home/user/social-signals-trader',
    runId: 'run-4056',
    statusHistory: [{ to: 'failed', at: new Date(now - 5 * DAY_MS).toISOString() }],
  };
  assert.equal(isRescanCandidate(job), true, 'fixture must be a genuine rescan candidate');

  const found = findStuckFailedJobs([job], now, STUCK_FAILED_ESCALATE_MS);
  assert.equal(found.length, 1);
  assert.equal(found[0].slug, '4056-outcome-stats');
  assert.equal(found[0].cwd, '/home/user/social-signals-trader');
  assert.ok(found[0].ageMs >= 5 * DAY_MS - 1000);
});

test('a second pass over the same row (after the caller stamps stuckFailedNotified) produces no second notification', () => {
  writeRunLog('run-4056b', 'repeat-offender', []);
  const now = Date.now();
  const job = {
    slug: 'repeat-offender',
    status: 'failed',
    runId: 'run-4056b',
    statusHistory: [{ to: 'failed', at: new Date(now - 2 * DAY_MS).toISOString() }],
  };
  assert.equal(findStuckFailedJobs([job], now, STUCK_FAILED_ESCALATE_MS).length, 1);

  // Simulate the caller stamping the row after the first notification.
  job.stuckFailedNotified = true;
  assert.equal(findStuckFailedJobs([job], now, STUCK_FAILED_ESCALATE_MS).length, 0, 'idempotency flag must suppress re-notification');
});

test('a failed row younger than the threshold is not reported', () => {
  writeRunLog('run-fresh', 'fresh-failure', []);
  const now = Date.now();
  const job = {
    slug: 'fresh-failure',
    status: 'failed',
    runId: 'run-fresh',
    statusHistory: [{ to: 'failed', at: new Date(now - 60_000).toISOString() }],
  };
  assert.equal(findStuckFailedJobs([job], now, STUCK_FAILED_ESCALATE_MS).length, 0);
});

test('a failed row with a real result event (genuine red gate, not a rescan candidate) is never reported, however old', () => {
  writeRunLog('run-genuine-red', 'genuine-red', [
    JSON.stringify({ type: 'result', subtype: 'success', is_error: true }),
  ]);
  const now = Date.now();
  const job = {
    slug: 'genuine-red',
    status: 'failed',
    runId: 'run-genuine-red',
    statusHistory: [{ to: 'failed', at: new Date(now - 10 * DAY_MS).toISOString() }],
  };
  assert.equal(isRescanCandidate(job), false);
  assert.equal(findStuckFailedJobs([job], now, STUCK_FAILED_ESCALATE_MS).length, 0);
});

test('a non-failed row, or a failed row with no recoverable failed timestamp, is skipped rather than guessed at', () => {
  const now = Date.now();
  assert.equal(findStuckFailedJobs([{ slug: 'a', status: 'needs_review' }], now, STUCK_FAILED_ESCALATE_MS).length, 0);
  writeRunLog('run-no-history', 'no-history', []);
  assert.equal(
    findStuckFailedJobs(
      [{ slug: 'no-history', status: 'failed', runId: 'run-no-history', statusHistory: [] }],
      now,
      STUCK_FAILED_ESCALATE_MS,
    ).length,
    0,
  );
});

test('stuckFailedEscalationDisabled reflects SM_STUCK_FAILED_ESCALATE_DISABLE', () => {
  const saved = process.env.SM_STUCK_FAILED_ESCALATE_DISABLE;
  try {
    delete process.env.SM_STUCK_FAILED_ESCALATE_DISABLE;
    assert.equal(stuckFailedEscalationDisabled(), false);
    process.env.SM_STUCK_FAILED_ESCALATE_DISABLE = '1';
    assert.equal(stuckFailedEscalationDisabled(), true);
  } finally {
    if (saved === undefined) delete process.env.SM_STUCK_FAILED_ESCALATE_DISABLE;
    else process.env.SM_STUCK_FAILED_ESCALATE_DISABLE = saved;
  }
});

/**
 * scheduler-ladder-cancelled.test.cjs
 *
 * A cancelled job (scheduler_cancel_job) must never be touched by the
 * automated review ladder (incident 2026-10-19, git-viewer).
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/scheduler-ladder-cancelled.test.cjs
 */

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ladder-cancelled-test-'));
process.env.HOME = tmpHome;

const { isCancelledRow } = require('../lib/scheduler/cancelledRow.cjs');
const reviewLadder = require('../scheduler/reviewLadder.cjs');
const {
  selectFailedAutoResetTargets,
  findStuckFailedJobs,
  selectExhaustedNeedsReviewTargets,
} = require('../scheduler/reviewLadder.cjs');

const MIN_MS = 60_000;
const THRESHOLD_MS = 10 * MIN_MS;
const now = Date.now();
const at = new Date(now - 60 * MIN_MS).toISOString();

const failedRow = (extra = {}) => ({
  slug: 'a',
  status: 'failed',
  verifierVerdict: 'no_result',
  statusHistory: [{ to: 'failed', at, source: 'spawnJob:fail' }],
  ...extra,
});
const cancelledByHistory = () =>
  failedRow({ statusHistory: [{ to: 'failed', at, source: 'remote:cancelJob' }] });

test('isCancelledRow: cancelledAt marker', () => {
  assert.equal(isCancelledRow(failedRow({ cancelledAt: new Date().toISOString() })), true);
});

test('isCancelledRow: statusHistory source fallback', () => {
  assert.equal(isCancelledRow(cancelledByHistory()), true);
});

test('isCancelledRow: false for ordinary, empty and nullish rows', () => {
  assert.equal(isCancelledRow(failedRow()), false);
  assert.equal(isCancelledRow(failedRow({ cancelledAt: '' })), false);
  assert.equal(isCancelledRow(null), false);
  assert.equal(isCancelledRow(undefined), false);
});

test('isCancelledRow: only the newest entry for the current status counts', () => {
  const j = failedRow({
    statusHistory: [
      { to: 'failed', at, source: 'remote:cancelJob' },
      { to: 'pending', at, source: 'resetJob' },
      { to: 'failed', at, source: 'spawnJob:fail' },
    ],
  });
  assert.equal(isCancelledRow(j), false);
});

test('selectFailedAutoResetTargets skips a cancelled row, selects an identical ordinary one', () => {
  const ok = failedRow({ slug: 'ok' });
  const cancelled = failedRow({ slug: 'c', cancelledAt: new Date().toISOString() });
  const byHistory = { ...cancelledByHistory(), slug: 'h' };
  const out = selectFailedAutoResetTargets([ok, cancelled, byHistory], now, THRESHOLD_MS);
  assert.deepEqual(out.map((t) => t.slug), ['ok']);
});

test('reviewLadder no longer exports isCancelledJob', () => {
  assert.equal('isCancelledJob' in reviewLadder, false);
});

test('selectFailedAutoResetTargets skips an error-only legacy cancelled row', () => {
  const ok = failedRow({ slug: 'ok' });
  const legacy = { slug: 'legacy', status: 'failed', verifierVerdict: 'no_result', error: 'cancelled via admin API', statusHistory: [{ to: 'failed', at, source: 'spawnJob:fail' }] };
  const out = selectFailedAutoResetTargets([ok, legacy], now, THRESHOLD_MS);
  assert.deepEqual(out.map((t) => t.slug), ['ok']);
});

test('findStuckFailedJobs skips cancelled rows', () => {
  const out = findStuckFailedJobs(
    [failedRow({ slug: 'c', cancelledAt: new Date().toISOString() }), { ...cancelledByHistory(), slug: 'h' }],
    now,
    THRESHOLD_MS,
  );
  assert.equal(out.length, 0);
});

test('selectExhaustedNeedsReviewTargets skips cancelled needs_review rows', () => {
  const row = {
    slug: 'n',
    status: 'needs_review',
    cancelledAt: new Date().toISOString(),
    autoFixAttempted: true,
    statusHistory: [{ to: 'needs_review', at }],
  };
  assert.equal(selectExhaustedNeedsReviewTargets([row], now, THRESHOLD_MS).length, 0);
});

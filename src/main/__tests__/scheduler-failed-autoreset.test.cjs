/**
 * scheduler-failed-autoreset.test.cjs
 *
 * Covers selectFailedAutoResetTargets (the bounded failed -> pending
 * auto-reset selector, PRD 1151) and failedAutoResetDisabled (its kill
 * switch) in isolation. selectFailedAutoResetTargets is pure — no IO, no
 * `require` inside the function — so unlike findStuckFailedJobs' own test
 * file, there is no run-log fixture to set up here.
 *
 * HOME is overridden to a tmp dir BEFORE requiring scheduler.cjs — see
 * scheduler-reap-dead-running-jobs.test.cjs's comment for why.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/scheduler-failed-autoreset.test.cjs
 */

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'failed-autoreset-test-'));
process.env.HOME = tmpHome;

const {
  selectFailedAutoResetTargets,
  FAILED_AUTORESET_CAP,
  failedAutoResetDisabled,
} = require('../scheduler.cjs');

const MIN_MS = 60_000;
const THRESHOLD_MS = 10 * MIN_MS;

test('a fresh failed row (under threshold) is not selected', () => {
  const now = Date.now();
  const job = {
    slug: 'fresh-failure',
    status: 'failed',
    statusHistory: [{ to: 'failed', at: new Date(now - 2 * MIN_MS).toISOString() }],
  };
  assert.equal(selectFailedAutoResetTargets([job], now, THRESHOLD_MS).length, 0);
});

test('a row past threshold is selected, with its current attempt count', () => {
  const now = Date.now();
  const job = {
    slug: 'ripe-for-reset',
    cwd: '/home/user/project',
    status: 'failed',
    failedAutoResetAttempts: 1,
    statusHistory: [{ to: 'failed', at: new Date(now - 15 * MIN_MS).toISOString() }],
  };
  const found = selectFailedAutoResetTargets([job], now, THRESHOLD_MS);
  assert.equal(found.length, 1);
  assert.equal(found[0].slug, 'ripe-for-reset');
  assert.equal(found[0].cwd, '/home/user/project');
  assert.equal(found[0].attempts, 1);
  assert.ok(found[0].ageMs >= 15 * MIN_MS - 1000);
});

test('a row at the cap (failedAutoResetAttempts: 3) is not selected', () => {
  const now = Date.now();
  const job = {
    slug: 'cap-exhausted',
    status: 'failed',
    failedAutoResetAttempts: FAILED_AUTORESET_CAP,
    statusHistory: [{ to: 'failed', at: new Date(now - 15 * MIN_MS).toISOString() }],
  };
  assert.equal(selectFailedAutoResetTargets([job], now, THRESHOLD_MS).length, 0);
});

test('a non-failed status is never selected', () => {
  const now = Date.now();
  const job = {
    slug: 'needs-review-row',
    status: 'needs_review',
    statusHistory: [{ to: 'failed', at: new Date(now - 15 * MIN_MS).toISOString() }],
  };
  assert.equal(selectFailedAutoResetTargets([job], now, THRESHOLD_MS).length, 0);
});

test('the newest failed entry gates the threshold, not the first one', () => {
  const now = Date.now();
  const job = {
    slug: 'refailed-recently',
    status: 'failed',
    failedAutoResetAttempts: 1,
    statusHistory: [
      { to: 'failed', at: new Date(now - 2 * 24 * 60 * MIN_MS).toISOString() },
      { to: 'pending', at: new Date(now - 23 * 60 * MIN_MS).toISOString() },
      { to: 'failed', at: new Date(now - 2 * MIN_MS).toISOString() },
    ],
  };
  assert.equal(selectFailedAutoResetTargets([job], now, THRESHOLD_MS).length, 0, 'the old failed entry must not be used to gate this row');
});

test('failedAutoResetDisabled reflects SM_FAILED_AUTORESET_DISABLE', () => {
  const saved = process.env.SM_FAILED_AUTORESET_DISABLE;
  try {
    delete process.env.SM_FAILED_AUTORESET_DISABLE;
    assert.equal(failedAutoResetDisabled(), false);
    process.env.SM_FAILED_AUTORESET_DISABLE = '1';
    assert.equal(failedAutoResetDisabled(), true);
  } finally {
    if (saved === undefined) delete process.env.SM_FAILED_AUTORESET_DISABLE;
    else process.env.SM_FAILED_AUTORESET_DISABLE = saved;
  }
});

/**
 * rateLimitWindow.test.cjs — resolveBindingRateLimitReset: reads the log's
 * OWN rate_limit_event windows and returns the reset of whichever window
 * actually bound (utilization >= 1.0), not the billing endpoint's five_hour
 * assumption (PRD 1118).
 *
 * Run: timeout 120 npx vitest run src/main/lib/__tests__/rateLimitWindow.test.cjs
 */

'use strict';

import { test } from 'vitest';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveBindingRateLimitReset } = require('../rateLimitWindow.cjs');

// Repo-tracked, byte-for-byte copy of the real incident log (2026-09-05
// starry-night-ships 429) so this test is hermetic — CI, a fresh clone, or
// this machine's own run-log retention sweep (runLogRetention.test.cjs)
// pruning the live copy must not turn this red for reasons unrelated to the
// code under test.
const TRACKED_FIXTURE = path.join(__dirname, 'fixtures', '204-mercury-steam-horse.log.txt');
const REAL_FIXTURE_LIVE_PATH = '/home/bilko/.claude/session-manager/scheduled-plans/runs/2026-09-05T16-32-18-381Z/204-mercury-steam-horse.log';

test('tracked fixture (verbatim copy of the real incident log): seven_day_overage_included (utilization 1.0) binds, not five_hour', () => {
  const reset = resolveBindingRateLimitReset(TRACKED_FIXTURE);
  assert.strictEqual(reset, 1789059600);
  assert.notStrictEqual(reset, 1788643800);
});

test('tracked fixture is byte-identical to the live incident log, when present on this machine', () => {
  if (!fs.existsSync(REAL_FIXTURE_LIVE_PATH)) return; // machine-local artifact, not guaranteed to exist
  assert.strictEqual(
    fs.readFileSync(TRACKED_FIXTURE, 'utf8'),
    fs.readFileSync(REAL_FIXTURE_LIVE_PATH, 'utf8'),
  );
});

function writeTmpLog(lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rate-limit-window-test-'));
  const file = path.join(dir, 'job.log');
  fs.writeFileSync(file, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
  return file;
}

test('no rate_limit_event in log → null', () => {
  const logPath = writeTmpLog(['[scheduler] starting job', '{"type":"system","subtype":"init"}']);
  assert.strictEqual(resolveBindingRateLimitReset(logPath), null);
});

test('rate_limit_event present but no window at/above 1.0 utilization → null', () => {
  const logPath = writeTmpLog([
    { type: 'rate_limit_event', rate_limit_info: { unifiedWindows: {
      five_hour: { utilization: 0, resetsAt: 1788643800 },
      seven_day: { utilization: 0.59, resetsAt: 1789059600 },
    } } },
  ]);
  assert.strictEqual(resolveBindingRateLimitReset(logPath), null);
});

test('multiple windows bind in the last event → the LATEST reset wins', () => {
  const logPath = writeTmpLog([
    { type: 'rate_limit_event', rate_limit_info: { unifiedWindows: {
      five_hour: { utilization: 1.0, resetsAt: 1000 },
      seven_day: { utilization: 1.0, resetsAt: 2000 },
    } } },
  ]);
  assert.strictEqual(resolveBindingRateLimitReset(logPath), 2000);
});

test('uses the LAST rate_limit_event in the log, not the first', () => {
  const logPath = writeTmpLog([
    { type: 'rate_limit_event', rate_limit_info: { unifiedWindows: {
      seven_day: { utilization: 0.3, resetsAt: 111 },
    } } },
    { type: 'other' },
    { type: 'rate_limit_event', rate_limit_info: { unifiedWindows: {
      seven_day_overage_included: { utilization: 1.0, resetsAt: 999 },
    } } },
  ]);
  assert.strictEqual(resolveBindingRateLimitReset(logPath), 999);
});

test('missing file → null (best-effort, matches readTail contract)', () => {
  assert.strictEqual(resolveBindingRateLimitReset('/nonexistent/path/job.log'), null);
});

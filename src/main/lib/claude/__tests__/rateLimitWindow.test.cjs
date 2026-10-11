/**
 * rateLimitWindow.test.cjs — resolveBindingRateLimitReset: reads the log's
 * OWN rate_limit_event windows and returns the reset of whichever window
 * actually bound (utilization >= 1.0), not the billing endpoint's five_hour
 * assumption (PRD 1118).
 *
 * Run: timeout 120 npx vitest run src/main/lib/claude/__tests__/rateLimitWindow.test.cjs
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
const TRACKED_FIXTURE = path.join(__dirname, '..', '..', '__tests__', 'fixtures', '204-mercury-steam-horse.log.txt');
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

test('rejected five_hour event → five_hour reset, not the later seven_day reset', () => {
  const logPath = writeTmpLog([
    '{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":1791174000,"rateLimitType":"five_hour","overageStatus":"rejected","isUsingOverage":false,"unifiedWindows":{"five_hour":{"utilization":1.04,"resetsAt":1791174000},"seven_day":{"utilization":0.84,"resetsAt":1791478800}}}}',
  ]);
  assert.strictEqual(resolveBindingRateLimitReset(logPath), 1791174000);
});

test('rejected seven_day event → seven_day reset (window lookup when top-level resetsAt absent)', () => {
  const logPath = writeTmpLog([
    { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'seven_day', unifiedWindows: {
      five_hour: { utilization: 0.2, resetsAt: 1791174000 },
      seven_day: { utilization: 1.01, resetsAt: 1791478800 },
    } } },
  ]);
  assert.strictEqual(resolveBindingRateLimitReset(logPath), 1791478800);
});

test('allowed-only log (job 1309 shape), seven_day 0.56 → null', () => {
  const logPath = writeTmpLog([
    '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":1791757800,"rateLimitType":"five_hour","isUsingOverage":false,"unifiedWindows":{"five_hour":{"utilization":0.35,"resetsAt":1791757800},"seven_day":{"utilization":0.56,"resetsAt":1792083600}}}}',
  ]);
  assert.strictEqual(resolveBindingRateLimitReset(logPath), null);
});

test('allowed event with a window over 1.0 (overage) → null', () => {
  const logPath = writeTmpLog([
    { type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning', unifiedWindows: {
      seven_day: { utilization: 1.1, resetsAt: 1792083600 },
    } } },
  ]);
  assert.strictEqual(resolveBindingRateLimitReset(logPath), null);
});

test('missing file → null (best-effort, matches readTail contract)', () => {
  assert.strictEqual(resolveBindingRateLimitReset('/nonexistent/path/job.log'), null);
});

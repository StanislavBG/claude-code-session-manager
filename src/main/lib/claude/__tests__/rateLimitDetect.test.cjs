/**
 * rateLimitDetect.test.cjs — detectRateLimitInLog true ONLY for a genuine
 * rejection (PRD 1857; 2026-10-11 false 4-day pause from allowed events).
 *
 * Run: timeout 120 npx vitest run src/main/lib/claude/__tests__/rateLimitDetect.test.cjs
 */

'use strict';

import { test } from 'vitest';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { detectRateLimitInLog } = require('../rateLimitDetect.cjs');

const ALLOWED = '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":1791757800,"rateLimitType":"five_hour","overageStatus":"rejected","overageDisabledReason":"org_level_disabled","isUsingOverage":false,"unifiedWindows":{"five_hour":{"utilization":0.35,"resetsAt":1791757800},"seven_day":{"utilization":0.56,"resetsAt":1792083600}}}}';
const REJECTED = '{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":1791174000,"rateLimitType":"five_hour","overageStatus":"rejected","isUsingOverage":false,"unifiedWindows":{"five_hour":{"utilization":1.04,"resetsAt":1791174000},"seven_day":{"utilization":0.84,"resetsAt":1791478800}}}}';
const RESULT_429 = '{"type":"result","subtype":"success","is_error":true,"api_error_status":429,"result":"You\'ve hit your session limit · resets 9:20pm (America/Los_Angeles)","terminal_reason":"api_error"}';
const PROGRESS = '{"type":"system","subtype":"task_progress","description":"working"}';

function writeTmpLog(lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-rate-limit-detect-test-'));
  const p = path.join(dir, 'run.log');
  fs.writeFileSync(p, lines.join('\n') + '\n');
  return p;
}

test('job 1309 shape: allowed-only events + watchdog SIGTERM exit 143 → false', () => {
  const p = writeTmpLog([
    PROGRESS, ALLOWED, PROGRESS, ALLOWED, ALLOWED, PROGRESS,
    '[scheduler] wall-clock budget watchdog: ran 45m (> 45m budget, estimateMinutes=15) — SIGTERM process group',
    '[scheduler] exit code=143 (raw code=143 signal=null) duration=2705s',
  ]);
  assert.strictEqual(detectRateLimitInLog(p), false);
});

test('allowed_warning events only → false', () => {
  const p = writeTmpLog([ALLOWED.replace('"allowed"', '"allowed_warning"')]);
  assert.strictEqual(detectRateLimitInLog(p), false);
});

test('real rejection (rate_limit_event rejected + result 429) → true', () => {
  assert.strictEqual(detectRateLimitInLog(writeTmpLog([ALLOWED, REJECTED, RESULT_429])), true);
});

test('rejected rate_limit_event alone → true', () => {
  assert.strictEqual(detectRateLimitInLog(writeTmpLog([REJECTED])), true);
});

test('result-only api_error_status 429 → true', () => {
  assert.strictEqual(detectRateLimitInLog(writeTmpLog([RESULT_429])), true);
});

test("result-only is_error \"You've reached your Fable limit.\" → true", () => {
  const p = writeTmpLog(['{"type":"result","subtype":"success","is_error":true,"result":"You\'ve reached your Fable limit."}']);
  assert.strictEqual(detectRateLimitInLog(p), true);
});

test('limit text in a non-error result → false', () => {
  const p = writeTmpLog(['{"type":"result","subtype":"success","is_error":false,"result":"You\'ve hit your limit"}']);
  assert.strictEqual(detectRateLimitInLog(p), false);
});

test('tool output mentioning 429 / rate limit / limit text / seven_day → false', () => {
  const p = writeTmpLog([
    '{"type":"user","message":{"content":[{"type":"tool_result","content":"HTTP 429 Too Many Requests: rate limit exceeded. You\'ve hit your limit \\"rateLimitType\\":\\"seven_day\\""}]}}',
    '{"type":"assistant","message":{"content":[{"type":"text","text":"\\"api_error_status\\":429 You\'ve hit your limit"}]}}',
  ]);
  assert.strictEqual(detectRateLimitInLog(p), false);
});

test('partial / non-JSON lines are skipped', () => {
  const p = writeTmpLog(['"status":"rejected"}}', 'garbage {', REJECTED]);
  assert.strictEqual(detectRateLimitInLog(p), true);
});

test('missing log file → false', () => {
  assert.strictEqual(detectRateLimitInLog(path.join(os.tmpdir(), 'sm-no-such-log-1857.log')), false);
});

/**
 * scheduler-transient-failure.test.cjs — classifying network-outage vs. real
 * code failures so a transient outage (PRD 543/545: ENOTFOUND) gets a bounded
 * requeue instead of burning a whole run + an auto-fix investigation on an
 * outage that has nothing to do with the code.
 *
 * Run: timeout 120 node --test src/main/__tests__/scheduler-transient-failure.test.cjs
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  detectNetworkErrorInLog,
  detectRateLimitInLog,
  classifyFailureOutcome,
  TRANSIENT_RETRY_CAP,
} = require('../scheduler.cjs');

// Real tail captured from the 543 incident run (2026-07-14T14-40-39-306Z),
// per the PRD's "reuse it, don't re-derive" instruction.
const NETWORK_OUTAGE_LOG_TAIL = String.raw`
{"type":"result","subtype":"success","is_error":true,"api_error_status":null,"duration_ms":592749,"duration_api_ms":83313,"num_turns":19,"result":"API Error: Unable to connect to API (ENOTFOUND)","stop_reason":"stop_sequence","session_id":"85b1a3f4-3625-4f2d-a9f0-b3994f062b39","total_cost_usd":0.75,"terminal_reason":"api_error","uuid":"cc041889-4497-4fca-9f83-73e3dae6de54"}
`;

const RATE_LIMIT_LOG_TAIL = String.raw`
{"type":"result","subtype":"error","is_error":true,"api_error_status":429,"rateLimitType":"five_hour","result":"You've hit your limit","uuid":"abc"}
`;

const REAL_CODE_FAILURE_LOG_TAIL = String.raw`
{"type":"result","subtype":"error","is_error":true,"result":"Error: expected 2 but got 3\n  at test/foo.test.ts:12:5","terminal_reason":"error_max_turns","uuid":"def"}
`;

function writeTmpLog(contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-transient-log-'));
  const p = path.join(dir, 'run.log');
  fs.writeFileSync(p, contents);
  return p;
}

test('detectNetworkErrorInLog fires only on terminal_reason:api_error + a network-class error', () => {
  const p = writeTmpLog(NETWORK_OUTAGE_LOG_TAIL);
  try {
    assert.strictEqual(detectNetworkErrorInLog(p), true);
  } finally {
    fs.rmSync(path.dirname(p), { recursive: true, force: true });
  }
});

test('detectNetworkErrorInLog does not fire on a genuine code failure (no terminal_reason:api_error)', () => {
  const p = writeTmpLog(REAL_CODE_FAILURE_LOG_TAIL);
  try {
    assert.strictEqual(detectNetworkErrorInLog(p), false);
  } finally {
    fs.rmSync(path.dirname(p), { recursive: true, force: true });
  }
});

test('detectNetworkErrorInLog does not fire on a rate-limit log (rateLimited handling stays separate)', () => {
  const p = writeTmpLog(RATE_LIMIT_LOG_TAIL);
  try {
    assert.strictEqual(detectNetworkErrorInLog(p), false);
    // And the reverse: the rate-limit detector doesn't fire on the network log.
    assert.strictEqual(detectRateLimitInLog(p), true);
  } finally {
    fs.rmSync(path.dirname(p), { recursive: true, force: true });
  }
});

test('detectRateLimitInLog does not fire on a network-outage log', () => {
  const p = writeTmpLog(NETWORK_OUTAGE_LOG_TAIL);
  try {
    assert.strictEqual(detectRateLimitInLog(p), false);
  } finally {
    fs.rmSync(path.dirname(p), { recursive: true, force: true });
  }
});

test('classifyFailureOutcome: ENOTFOUND-class network error with a clean tree retries (bounded)', () => {
  const decision = classifyFailureOutcome({
    exitCode: 1,
    networkError: true,
    durationMs: 594_000,
    transientRetries: 0,
    newlyDirtyCount: 0,
  });
  assert.strictEqual(decision.action, 'retry');
  assert.strictEqual(decision.transientKind, 'network');
  assert.strictEqual(decision.retries, 0);
});

test('classifyFailureOutcome: network error with uncommitted work left behind refuses to requeue', () => {
  const decision = classifyFailureOutcome({
    exitCode: 1,
    networkError: true,
    durationMs: 594_000,
    transientRetries: 0,
    newlyDirtyCount: 2,
  });
  assert.strictEqual(decision.action, 'fail-dirty');
  assert.strictEqual(decision.newlyDirtyCount, 2);
});

test('classifyFailureOutcome: retry cap exhausted fails without auto-fix, never loops unboundedly', () => {
  const decision = classifyFailureOutcome({
    exitCode: 1,
    networkError: true,
    durationMs: 594_000,
    transientRetries: TRANSIENT_RETRY_CAP,
    newlyDirtyCount: 0,
  });
  assert.strictEqual(decision.action, 'fail-cap');
  assert.strictEqual(decision.retries, TRANSIENT_RETRY_CAP);
});

test('classifyFailureOutcome: a genuine code failure (non-network exit 1) is still terminal + investigated', () => {
  const decision = classifyFailureOutcome({
    exitCode: 1,
    networkError: false,
    durationMs: 30_000,
    transientRetries: 0,
    newlyDirtyCount: 0,
  });
  assert.strictEqual(decision.action, 'investigate');
});

test('classifyFailureOutcome: signal-kill transient (exit 143, short run) still retries as before', () => {
  const decision = classifyFailureOutcome({
    exitCode: 143,
    networkError: false,
    durationMs: 60_000,
    transientRetries: 0,
    newlyDirtyCount: 0,
  });
  assert.strictEqual(decision.action, 'retry');
  assert.strictEqual(decision.transientKind, 'exit=143');
});

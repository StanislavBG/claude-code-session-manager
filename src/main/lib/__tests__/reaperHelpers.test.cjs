/**
 * reaperHelpers.test.cjs — selectReapableJobs: the pure predicate behind
 * reapDeadRunningJobs()'s pidless-zombie fix.
 *
 * Prior behaviour: a 'running' row with no runtime.pid was skipped forever,
 * unconditionally ("spawn may be mid-flight; give it a cycle") — no age
 * bound. Repro 2026-09-01: a row sat pidless for 464 minutes against a
 * 24-minute estimate, empty run dir, no claude process anywhere — nothing
 * pid-bound (deadman, idle watchdog, supervisor) could ever see it.
 *
 * Run: timeout 120 npx vitest run src/main/lib/__tests__/reaperHelpers.test.cjs
 */

'use strict';

// vitest, NOT node:test — this repo's suite is vitest-only (CLAUDE.md).
import { test } from 'vitest';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { selectReapableJobs, mapOutcomeToGateOutcome, classifyRunOutcome } = require('../reaperHelpers.cjs');
const { detectRateLimitInLog } = require('../rateLimitDetect.cjs');

const NOW = Date.parse('2026-09-01T12:00:00.000Z');
const agoMin = (m) => new Date(NOW - m * 60_000).toISOString();
const GRACE = 10 * 60_000;
const alwaysDead = () => false;
const alwaysAlive = () => true;

test('pidless + older than grace → reaped, with a named reason', () => {
  const jobs = [{ slug: 'zombie', status: 'running', startedAt: agoMin(464) }];
  const { reapable, warnings } = selectReapableJobs(jobs, NOW, { pidAlive: alwaysAlive, grace: GRACE });
  assert.strictEqual(warnings.length, 0);
  assert.strictEqual(reapable.length, 1);
  assert.strictEqual(reapable[0].slug, 'zombie');
  assert.strictEqual(reapable[0].pid, null);
  assert.strictEqual(reapable[0].pidless, true);
  assert.match(reapable[0].reason, /no runtime\.pid recorded after 10m/);
});

test('pidless + within grace → skipped (the genuine mid-flight-spawn case)', () => {
  const jobs = [{ slug: 'fresh', status: 'running', startedAt: agoMin(2) }];
  const { reapable, warnings } = selectReapableJobs(jobs, NOW, { pidAlive: alwaysAlive, grace: GRACE });
  assert.deepStrictEqual(reapable, []);
  assert.deepStrictEqual(warnings, []);
});

test('pidless + exactly at grace boundary → reaped (>= not >)', () => {
  const jobs = [{ slug: 'boundary', status: 'running', startedAt: agoMin(10) }];
  const { reapable } = selectReapableJobs(jobs, NOW, { pidAlive: alwaysAlive, grace: GRACE });
  assert.strictEqual(reapable.length, 1);
});

test('live pid → skipped regardless of age', () => {
  const jobs = [{ slug: 'live', status: 'running', runtime: { pid: 4242 }, startedAt: agoMin(500) }];
  const { reapable } = selectReapableJobs(jobs, NOW, { pidAlive: alwaysAlive, grace: GRACE });
  assert.deepStrictEqual(reapable, []);
});

test('dead pid → reaped exactly as before (pidless: false, no reason string)', () => {
  const jobs = [{ slug: 'dead', status: 'running', runtime: { pid: 4242 }, startedAt: agoMin(500) }];
  const { reapable } = selectReapableJobs(jobs, NOW, { pidAlive: alwaysDead, grace: GRACE });
  assert.strictEqual(reapable.length, 1);
  assert.strictEqual(reapable[0].slug, 'dead');
  assert.strictEqual(reapable[0].pid, 4242);
  assert.strictEqual(reapable[0].pidless, false);
});

test('pidless + missing startedAt → skipped and warned, not reaped', () => {
  const jobs = [{ slug: 'no-started-at', status: 'running' }];
  const { reapable, warnings } = selectReapableJobs(jobs, NOW, { pidAlive: alwaysAlive, grace: GRACE });
  assert.deepStrictEqual(reapable, []);
  assert.strictEqual(warnings.length, 1);
  assert.strictEqual(warnings[0].slug, 'no-started-at');
});

test('pidless + unparseable startedAt → skipped and warned, not reaped', () => {
  const jobs = [{ slug: 'bad-started-at', status: 'running', startedAt: 'not-a-date' }];
  const { reapable, warnings } = selectReapableJobs(jobs, NOW, { pidAlive: alwaysAlive, grace: GRACE });
  assert.deepStrictEqual(reapable, []);
  assert.strictEqual(warnings.length, 1);
  assert.strictEqual(warnings[0].slug, 'bad-started-at');
});

test('pidless + startedAt in the future (clock skew) → skipped, not reaped', () => {
  const jobs = [{ slug: 'future', status: 'running', startedAt: agoMin(-60) }];
  const { reapable, warnings } = selectReapableJobs(jobs, NOW, { pidAlive: alwaysAlive, grace: GRACE });
  assert.deepStrictEqual(reapable, []);
  assert.deepStrictEqual(warnings, []);
});

test('non-running rows are never considered, pidless or not', () => {
  const jobs = [
    { slug: 'a', status: 'pending', startedAt: agoMin(500) },
    { slug: 'b', status: 'completed', startedAt: agoMin(500) },
    { slug: 'c', status: 'failed', runtime: { pid: 1 }, startedAt: agoMin(500) },
  ];
  const { reapable, warnings } = selectReapableJobs(jobs, NOW, { pidAlive: alwaysDead, grace: GRACE });
  assert.deepStrictEqual(reapable, []);
  assert.deepStrictEqual(warnings, []);
});

test('mixed batch: each row classified independently', () => {
  const jobs = [
    { slug: 'zombie', status: 'running', startedAt: agoMin(464) },
    { slug: 'fresh', status: 'running', startedAt: agoMin(2) },
    { slug: 'live', status: 'running', runtime: { pid: 1 }, startedAt: agoMin(500) },
    { slug: 'dead', status: 'running', runtime: { pid: 2 }, startedAt: agoMin(500) },
    { slug: 'bad-started-at', status: 'running', startedAt: 'nope' },
  ];
  const pidAlive = (pid) => pid === 1;
  const { reapable, warnings } = selectReapableJobs(jobs, NOW, { pidAlive, grace: GRACE });
  assert.deepStrictEqual(reapable.map((r) => r.slug).sort(), ['dead', 'zombie']);
  assert.deepStrictEqual(warnings.map((w) => w.slug), ['bad-started-at']);
});

// mapOutcomeToGateOutcome — classifyRunOutcome's four-way result collapsed
// onto the persisted `gateOutcome` field (PRD 1109). 'no_result' -> 'never_ran'
// is the one non-obvious mapping: a missing verdict event means the gate
// never fired, a distinct fact from 'failed' (a verdict event exists and
// says error).
test('mapOutcomeToGateOutcome: success -> passed', () => {
  assert.strictEqual(mapOutcomeToGateOutcome('success'), 'passed');
});

test('mapOutcomeToGateOutcome: failed -> failed', () => {
  assert.strictEqual(mapOutcomeToGateOutcome('failed'), 'failed');
});

test('mapOutcomeToGateOutcome: no_result -> never_ran', () => {
  assert.strictEqual(mapOutcomeToGateOutcome('no_result'), 'never_ran');
});

test('mapOutcomeToGateOutcome: unknown -> unknown', () => {
  assert.strictEqual(mapOutcomeToGateOutcome('unknown'), 'unknown');
});

// detectRateLimitInLog / classifyRunOutcome — PRD 1117: the reaper's
// rate-limit detection must be the SAME single source of truth spawnJob
// uses (detectRateLimitInLog, shared via lib/rateLimitDetect.cjs), and a
// rate-limited death must classify as a NEW, distinct 'rate_limited'
// outcome — never collapsed into 'failed', and never re-labelling
// 'success'/'failed'/'no_result' (which keep their prior meanings, per the
// mapOutcomeToGateOutcome tests above, unmodified).

function writeTmpLog(contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-reaper-rate-limit-test-'));
  const p = path.join(dir, 'run.log');
  fs.writeFileSync(p, contents);
  return p;
}

test('detectRateLimitInLog: rateLimitType":"five_hour" variant', () => {
  const p = writeTmpLog('{"type":"result","rate_limit_info":{"rateLimitType":"five_hour"}}\n');
  assert.strictEqual(detectRateLimitInLog(p), true);
});

test('detectRateLimitInLog: rateLimitType":"seven_day" variant (missed pre-PRD-1117)', () => {
  const p = writeTmpLog('{"type":"rate_limit_event","rate_limit_info":{"rateLimitType":"seven_day","unifiedWindows":{"five_hour":{"utilization":0}}}}\n');
  assert.strictEqual(detectRateLimitInLog(p), true);
});

test('detectRateLimitInLog: api_error_status":429 variant', () => {
  const p = writeTmpLog('{"type":"result","is_error":true,"api_error_status":429,"result":"nope"}\n');
  assert.strictEqual(detectRateLimitInLog(p), true);
});

test('detectRateLimitInLog: "You\'ve reached your <model> limit" variant (missed pre-PRD-1117)', () => {
  const p = writeTmpLog('{"type":"result","result":"You\'ve reached your Fable limit. Switch to another model."}\n');
  assert.strictEqual(detectRateLimitInLog(p), true);
});

test('detectRateLimitInLog: real evidence log (2026-09-05 204-mercury-steam-horse 429)', () => {
  const evidencePath = '/home/bilko/.claude/session-manager/scheduled-plans/runs/2026-09-05T16-32-18-381Z/204-mercury-steam-horse.log';
  if (!fs.existsSync(evidencePath)) return; // machine-local fixture; skip elsewhere
  assert.strictEqual(detectRateLimitInLog(evidencePath), true);
});

test('classifyRunOutcome: a 429 log tail classifies as the new distinct rate_limited outcome, not failed', () => {
  const p = writeTmpLog('{"type":"result","subtype":"success","is_error":true,"api_error_status":429,"rateLimitType":"seven_day","result":"You\'ve reached your Fable limit."}\n');
  assert.strictEqual(classifyRunOutcome(p), 'rate_limited');
});

test('classifyRunOutcome: a genuine error with no rate-limit signal still classifies as failed', () => {
  const p = writeTmpLog('{"type":"result","subtype":"error","is_error":true,"result":"Error: expected 2 but got 3"}\n');
  assert.strictEqual(classifyRunOutcome(p), 'failed');
});

// REGRESSION GUARD (2026-09-05). The rate-limit check originally ran as the
// FIRST statement of classifyRunOutcome, before the result event was parsed.
// Because the CLI emits an informational rate_limit_event with
// status:"allowed_warning" on nearly every run once utilization is non-zero,
// that misclassified genuinely successful runs as 'rate_limited' — which in
// reapDeadRunningJobs re-queues finished work and spuriously pauses the whole
// machine. The fixture below is the shape of a REAL successful run log, not a
// synthetic one-liner: the allowed_warning event that every run carries, then
// a clean result. If someone moves the check back to the top, this goes red.
test('classifyRunOutcome: a SUCCESSFUL run whose tail carries an allowed_warning rate_limit_event is still success', () => {
  const p = writeTmpLog([
    '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed_warning","resetsAt":1788643800,"rateLimitType":"five_hour","utilization":0.42,"isUsingOverage":false}}',
    '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed_warning","resetsAt":1789059600,"rateLimitType":"seven_day","utilization":0.59,"isUsingOverage":false}}',
    '{"type":"result","subtype":"success","is_error":false,"num_turns":55,"result":"SCHEDULER_VERDICT: PASS"}',
  ].join('\n') + '\n');
  assert.strictEqual(classifyRunOutcome(p), 'success');
  assert.strictEqual(mapOutcomeToGateOutcome(classifyRunOutcome(p)), 'passed');
});

// The same tail, but the run actually errored: NOW the rate-limit signal is
// what it claims to be, and the outcome must be the retryable one.
test('classifyRunOutcome: the same allowed_warning tail on an ERRORED run classifies as rate_limited', () => {
  const p = writeTmpLog([
    '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed_warning","rateLimitType":"seven_day","utilization":0.59}}',
    '{"type":"result","subtype":"success","is_error":true,"api_error_status":429,"result":"You\'ve reached your Fable limit."}',
  ].join('\n') + '\n');
  assert.strictEqual(classifyRunOutcome(p), 'rate_limited');
});

test('classifyRunOutcome: a clean success log still classifies as success', () => {
  const p = writeTmpLog('{"type":"result","subtype":"success","is_error":false,"result":"done"}\n');
  assert.strictEqual(classifyRunOutcome(p), 'success');
});

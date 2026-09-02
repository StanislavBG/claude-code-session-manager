/**
 * launchFailure.test.cjs — the non-run classifier + launch circuit breaker
 * behind GitHub issue #11 (macOS, 2026-09-02): an outdated Claude CLI sent
 * `thinking.type.enabled`, the API answered HTTP 400 on the first request,
 * and 12 of 41 runs in one project were recorded as `failed` with
 * `error: null` and then investigated by a probe that died the same way.
 *
 * Run: timeout 120 npx vitest run src/main/lib/__tests__/launchFailure.test.cjs
 */

'use strict';

import { test, expect } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const lf = require('../launchFailure.cjs');

// Verbatim shape from the issue-#11 transcript (2c3cd24f-…ccf0eb290fff.jsonl):
// a single assistant entry that IS the raw API error, then the result event.
const THINKING_400_RESULT = {
  type: 'result', subtype: 'error', is_error: true, api_error_status: 400, num_turns: 1,
  duration_ms: 23811, total_cost_usd: 0,
  usage: { input_tokens: 0, output_tokens: 0 },
  result: 'API Error: 400 {"detail":{"error":"{\\"message\\":\\"\\\\\\"thinking.type.enabled\\\\\\" is not supported for this model. Use \\\\\\"thinking.type.adaptive\\\\\\" and \\\\\\"output_config.effort\\\\\\" to control thinking behavior.\\"}"}}',
};

const REAL_WORK_FAILURE = {
  type: 'result', subtype: 'error', is_error: true, num_turns: 19,
  usage: { input_tokens: 4000, output_tokens: 2200 },
  result: 'Error: expected 2 but got 3\n  at test/foo.test.ts:12:5', terminal_reason: 'error_max_turns',
};

function tmpLog(lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-launch-'));
  const p = path.join(dir, 'run.log');
  fs.writeFileSync(p, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
  return p;
}

test('parseResultEvent: flattens the last result event with turns/tokens/status', () => {
  const r = lf.parseResultEvent([
    '[scheduler] starting foo',
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'API Error: 400 …' }] } }),
    JSON.stringify(THINKING_400_RESULT),
  ].join('\n'));
  expect(r).toMatchObject({ subtype: 'error', isError: true, numTurns: 1, outputTokens: 0, apiErrorStatus: 400 });
  expect(r.resultText).toMatch(/thinking\.type\.enabled/);
});

test('parseResultEvent: null when no result event exists (process died first)', () => {
  expect(lf.parseResultEvent('[scheduler] starting\n{"type":"system","subtype":"init"}\n')).toBeNull();
  expect(lf.parseResultEvent('')).toBeNull();
});

test('classifyLaunchFailure: the issue-#11 thinking 400 → model_config_rejected with the API message', () => {
  const c = lf.classifyLaunchFailure(lf.parseResultEvent(JSON.stringify(THINKING_400_RESULT)));
  expect(c).not.toBeNull();
  expect(c.kind).toBe('model_config_rejected');
  expect(c.httpStatus).toBe(400);
  expect(c.message).toMatch(/thinking\.type\.enabled.*not supported for this model/);
  expect(c.message).not.toMatch(/^API Error/);
});

test('classifyLaunchFailure: a run that took real turns is NEVER a launch failure, even with API Error text', () => {
  expect(lf.classifyLaunchFailure(lf.parseResultEvent(JSON.stringify(REAL_WORK_FAILURE)))).toBeNull();
  const lateApiError = { ...THINKING_400_RESULT, num_turns: 7, usage: { output_tokens: 900 } };
  expect(lf.classifyLaunchFailure(lf.parseResultEvent(JSON.stringify(lateApiError)))).toBeNull();
});

test('classifyLaunchFailure: zero-turn failure WITHOUT the API Error marker is not classified (someone else owns it)', () => {
  const r = lf.parseResultEvent(JSON.stringify({ type: 'result', subtype: 'error', is_error: true, num_turns: 1, usage: { output_tokens: 0 }, result: 'Invalid prompt' }));
  expect(lf.classifyLaunchFailure(r)).toBeNull();
});

test('classifyLaunchFailure: 429 is left to the rate-limit path', () => {
  const r = lf.parseResultEvent(JSON.stringify({ type: 'result', subtype: 'error', is_error: true, api_error_status: 429, num_turns: 1, usage: { output_tokens: 0 }, result: 'API Error: 429 {"error":{"message":"rate limited"}}' }));
  expect(lf.classifyLaunchFailure(r)).toBeNull();
});

test('classifyLaunchFailure: status → kind mapping', () => {
  const mk = (status, text) => lf.classifyLaunchFailure(lf.parseResultEvent(JSON.stringify({
    type: 'result', subtype: 'error', is_error: true, num_turns: 1, usage: { output_tokens: 0 }, result: `API Error: ${status} ${text}`,
  })));
  expect(mk(401, '{"error":{"message":"invalid x-api-key"}}').kind).toBe('auth_failed');
  expect(mk(403, '{"error":{"message":"forbidden"}}').kind).toBe('auth_failed');
  expect(mk(404, '{"error":{"message":"model: claude-x not found"}}').kind).toBe('model_not_found');
  expect(mk(400, '{"error":{"message":"max_tokens must be > 0"}}').kind).toBe('bad_request');
  expect(mk(529, '{"error":{"type":"overloaded_error","message":"Overloaded"}}').kind).toBe('api_overloaded');
  expect(mk(500, '{"error":{"message":"internal"}}').kind).toBe('api_overloaded');
  expect(mk(418, 'teapot').kind).toBe('api_error');
  expect(mk(401, '{"error":{"message":"invalid x-api-key"}}').message).toBe('invalid x-api-key');
});

test('readResultEvent + classify on a real log tail (scheduler log lines interleaved)', () => {
  const p = tmpLog([
    '[scheduler] starting 04-fix-cdp at 2026-09-02T17:54:14.770Z',
    { type: 'system', subtype: 'init', session_id: 'x' },
    { type: 'user', message: { content: [{ type: 'text', text: 'PRD body' }] } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'API Error: 400 …' }] } },
    THINKING_400_RESULT,
    '[scheduler] exit code=1 (raw code=1 signal=null) duration=25s',
  ]);
  try {
    const r = lf.readResultEvent(p);
    expect(lf.classifyLaunchFailure(r)?.kind).toBe('model_config_rejected');
    expect(lf.resultShowsRealTurn(r)).toBe(false);
  } finally {
    fs.rmSync(path.dirname(p), { recursive: true, force: true });
  }
});

test('resultShowsRealTurn: true once a turn or any output token happened', () => {
  expect(lf.resultShowsRealTurn({ numTurns: 1, outputTokens: 0 })).toBe(false);
  expect(lf.resultShowsRealTurn({ numTurns: 2, outputTokens: 0 })).toBe(true);
  expect(lf.resultShowsRealTurn({ numTurns: 1, outputTokens: 12 })).toBe(true);
  expect(lf.resultShowsRealTurn(null)).toBe(false);
});

// ─── circuit breaker ────────────────────────────────────────────────────────

const T0 = Date.parse('2026-09-02T18:00:00Z');

test('armLaunchBlock: first failure opens with the kind backoff, a mitigation env, and an operator hint', () => {
  const b = lf.armLaunchBlock(null, { kind: 'model_config_rejected', httpStatus: 400, message: 'm', now: T0, claudeVersion: '1.0.90', slug: 'a', runId: 'r1' });
  expect(b.attempts).toBe(1);
  expect(b.exhausted).toBe(false);
  expect(Date.parse(b.until) - T0).toBe(lf.backoffMsFor('model_config_rejected', 1));
  expect(b.mitigationEnv).toEqual({ MAX_THINKING_TOKENS: '0' });
  expect(b.hint).toMatch(/claude update/);
  expect(b.claudeVersion).toBe('1.0.90');
  expect(b.probing).toBeNull();
});

test('armLaunchBlock: repeated same-kind failures escalate, cap at 60 min, then exhaust (until=null)', () => {
  let b = null;
  const seen = [];
  for (let i = 0; i < lf.LAUNCH_BLOCK_MAX_ATTEMPTS; i++) {
    b = lf.armLaunchBlock(b, { kind: 'api_error', message: 'x', now: T0 + i * 1000 });
    seen.push(b.until ? Date.parse(b.until) - (T0 + i * 1000) : null);
  }
  expect(b.attempts).toBe(lf.LAUNCH_BLOCK_MAX_ATTEMPTS);
  expect(b.exhausted).toBe(true);
  expect(b.until).toBeNull();
  const finite = seen.filter((x) => x !== null);
  for (let i = 1; i < finite.length; i++) expect(finite[i]).toBeGreaterThanOrEqual(finite[i - 1]);
  expect(Math.max(...finite)).toBeLessThanOrEqual(60 * 60_000);
  expect(b.since).toBe(new Date(T0).toISOString()); // first-failure time survives re-arming
});

test('armLaunchBlock: a different kind restarts the attempt count', () => {
  const a = lf.armLaunchBlock(null, { kind: 'api_overloaded', message: 'x', now: T0 });
  const b = lf.armLaunchBlock(a, { kind: 'api_overloaded', message: 'x', now: T0 + 1 });
  const c = lf.armLaunchBlock(b, { kind: 'auth_failed', message: 'y', now: T0 + 2 });
  expect(b.attempts).toBe(2);
  expect(c.attempts).toBe(1);
  expect(c.mitigationEnv).toBeNull();
});

test('evaluateLaunchGate: open → blocked during backoff → probe after → blocked while a probe is in flight', () => {
  expect(lf.evaluateLaunchGate(null, { now: T0 }).state).toBe('open');
  const b = lf.armLaunchBlock(null, { kind: 'model_config_rejected', message: 'm', now: T0, claudeVersion: '1.0.90' });
  expect(lf.evaluateLaunchGate(b, { now: T0 + 1000, claudeVersion: '1.0.90' }).state).toBe('blocked');
  expect(lf.evaluateLaunchGate(b, { now: T0 + 1000 }).reason).toMatch(/re-probe in \d+ min/);
  const afterBackoff = Date.parse(b.until) + 1;
  expect(lf.evaluateLaunchGate(b, { now: afterBackoff, claudeVersion: '1.0.90' }).state).toBe('probe');
  const probing = { ...b, probing: { slug: 'p', at: new Date(afterBackoff).toISOString() } };
  const g = lf.evaluateLaunchGate(probing, { now: afterBackoff + 60_000, claudeVersion: '1.0.90' });
  expect(g.state).toBe('blocked');
  expect(g.reason).toMatch(/probe p in flight/);
  // a probe that never reported back goes stale and the gate re-opens to a new probe
  expect(lf.evaluateLaunchGate(probing, { now: afterBackoff + lf.LAUNCH_PROBE_STALE_MS + 1, claudeVersion: '1.0.90' }).state).toBe('probe');
});

test('evaluateLaunchGate: a CLI version change short-circuits the backoff (the real fix for issue #11)', () => {
  const b = lf.armLaunchBlock(null, { kind: 'model_config_rejected', message: 'm', now: T0, claudeVersion: '1.0.90' });
  const g = lf.evaluateLaunchGate(b, { now: T0 + 1000, claudeVersion: '1.0.128' });
  expect(g.state).toBe('open');
  expect(g.reason).toMatch(/cli-version-changed/);
  // unknown current version (probe failed) → no shortcut, backoff still holds
  expect(lf.evaluateLaunchGate(b, { now: T0 + 1000, claudeVersion: null }).state).toBe('blocked');
});

test('evaluateLaunchGate: an exhausted block stays blocked until version change', () => {
  let b = null;
  for (let i = 0; i < lf.LAUNCH_BLOCK_MAX_ATTEMPTS; i++) b = lf.armLaunchBlock(b, { kind: 'auth_failed', message: 'x', now: T0, claudeVersion: 'v1' });
  expect(lf.evaluateLaunchGate(b, { now: T0 + 365 * 24 * 3600_000, claudeVersion: 'v1' }).state).toBe('blocked');
  expect(lf.evaluateLaunchGate(b, { now: T0 + 1, claudeVersion: 'v2' }).state).toBe('open');
});

test('launchBlockKeyFor: persona is the key, default when absent', () => {
  expect(lf.launchBlockKeyFor({ agentType: 'dev-lead' })).toBe('dev-lead');
  expect(lf.launchBlockKeyFor({})).toBe('default');
  expect(lf.launchBlockKeyFor(null)).toBe('default');
});

test('deriveTerminalReason: closed-set taxonomy', () => {
  expect(lf.deriveTerminalReason({ effectiveStatus: 'completed', exitCode: 0 })).toBe('completed');
  expect(lf.deriveTerminalReason({ effectiveStatus: 'failed', exitCode: 1 })).toBe('impl_failed:exit_1');
  expect(lf.deriveTerminalReason({ effectiveStatus: 'failed', exitCode: 143 })).toBe('signal_kill');
  expect(lf.deriveTerminalReason({ effectiveStatus: 'needs_review', exitCode: 143, sigtermOverride: { status: 'needs_review' } })).toBe('signal_kill_with_commit');
  expect(lf.deriveTerminalReason({ effectiveStatus: 'needs_review', exitCode: 0, verifyResult: { verdict: 'silent_no_op' } })).toBe('verifier:silent_no_op');
  expect(lf.deriveTerminalReason({ effectiveStatus: 'needs_review', exitCode: 0, worktreeIntegrationFailure: 'conflict' })).toBe('worktree_integration_failed');
});

test('writeOutcomeSidecar: writes <slug>.outcome.json atomically and never throws on a bad dir', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-outcome-'));
  try {
    const p = lf.writeOutcomeSidecar(dir, '12-foo', { numTurns: 1, outputTokens: 0, terminalReason: 'launch_failure:model_config_rejected' });
    expect(p).toBe(path.join(dir, '12-foo.outcome.json'));
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
    expect(parsed).toMatchObject({ slug: '12-foo', numTurns: 1, outputTokens: 0, terminalReason: 'launch_failure:model_config_rejected' });
    expect(parsed.writtenAt).toMatch(/^\d{4}-/);
    expect(fs.existsSync(`${p}.tmp`)).toBe(false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  expect(lf.writeOutcomeSidecar('/nonexistent/dir/for/sure', 'x', {})).toBeNull();
  expect(lf.writeOutcomeSidecar(null, 'x', {})).toBeNull();
});

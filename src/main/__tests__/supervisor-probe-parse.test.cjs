/**
 * supervisor-probe-parse.test.cjs — parseProbeOutput turns the probe's
 * `--output-format json` stdout into a verdict, a cost, and (for budget/error
 * exits) an error subtype, so runProbe never records those as a plain 'ok'.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/supervisor-probe-parse.test.cjs
 */
'use strict';

import { test, expect } from 'vitest';

const { parseProbeOutput } = require('../supervisor.cjs');

test('success result with an embedded verdict JSON yields verdictObj and cost', () => {
  const stdout = JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    total_cost_usd: 0.0421,
    result: 'Here: {"verdict":"stuck","action":"kill-bash","targetPid":123,"reason":"poll loop"}',
  }) + '\n';
  const out = parseProbeOutput(stdout);
  expect(out.verdictObj).toEqual({ verdict: 'stuck', action: 'kill-bash', targetPid: 123, reason: 'poll loop' });
  expect(out.costUsd).toBe(0.0421);
  expect(out.errorSubtype).toBeNull();
});

test('error_max_budget_usd result with no result field yields errorSubtype', () => {
  const stdout = JSON.stringify({
    type: 'result',
    subtype: 'error_max_budget_usd',
    is_error: false,
    total_cost_usd: 0.3015,
  }) + '\n';
  const out = parseProbeOutput(stdout);
  expect(out.verdictObj).toBeNull();
  expect(out.costUsd).toBe(0.3015);
  expect(out.errorSubtype).toBe('error_max_budget_usd');
});

test('is_error true without a subtype still reports an error subtype', () => {
  const out = parseProbeOutput(JSON.stringify({ type: 'result', is_error: true, total_cost_usd: 0.01 }));
  expect(out.verdictObj).toBeNull();
  expect(out.errorSubtype).toBe('error');
});

test('non-JSON garbage yields neither a verdict nor an error subtype', () => {
  const out = parseProbeOutput('Segmentation fault\nnot json at all\n');
  expect(out.verdictObj).toBeNull();
  expect(out.costUsd).toBeNull();
  expect(out.errorSubtype).toBeNull();
});

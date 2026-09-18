/**
 * health-usage-poller.test.cjs — `npm run health` must report GREEN / YELLOW
 * / RED for the usage/rate-limit poller (scheduler.cjs pollLoop), driven by
 * the shared usageCircuit's OWN open/closed state and how long it's been
 * open (usageCircuitState/usageCircuitOpenedAt, persisted to
 * ~/.claude/session-manager/scheduler-state.json by persistSchedulerState —
 * this is a separate `npm run health` process, so it reads the PERSISTED
 * circuit fields rather than holding the live in-memory breaker) — not the
 * old binary consecutiveFailures<5 check, which read flatly non-GREEN
 * forever after the fifth failure with no way to distinguish "just tripped"
 * from "down for hours." Exercises evaluateUsagePollerHealth() and
 * loadUsagePollerState() directly since both are pure/file-scoped, matching
 * every other evaluate* helper's test pattern in this file — deliberately NOT
 * driving the full (slow, machine-state-coupled) check() for this.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/health-usage-poller.test.cjs
 */

'use strict';

import { test, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const { evaluateUsagePollerHealth, loadUsagePollerState } = require('../health.cjs');
const { FAILURE_STREAK_ESCALATION_MS } = require('../scheduler.cjs');

test('missing state (fresh install / poller never ran) is ok, not applicable', () => {
  expect(evaluateUsagePollerHealth(null)).toEqual({ ok: true, applicable: false });
  expect(evaluateUsagePollerHealth(undefined)).toEqual({ ok: true, applicable: false });
});

test('circuit closed is GREEN, regardless of a nonzero consecutiveFailures count', () => {
  const result = evaluateUsagePollerHealth({ usageCircuitState: 'closed', consecutiveFailures: 2, backoffMs: 60_000, lastPollAt: Date.now() });
  expect(result.ok).toBe(true);
  expect(result.applicable).toBe(true);
  expect(result.color).toBe('GREEN');
  expect(result.message).toBeUndefined();
});

test('no usageCircuitState field at all (pre-upgrade sidecar) defaults to closed -> GREEN', () => {
  const result = evaluateUsagePollerHealth({ consecutiveFailures: 0, backoffMs: null, lastPollAt: Date.now() });
  expect(result.ok).toBe(true);
  expect(result.color).toBe('GREEN');
});

test('circuit open for under FAILURE_STREAK_ESCALATION_MS (30 min) is YELLOW, not GREEN — but still ok:true, not yet critical', () => {
  const now = Date.now();
  const result = evaluateUsagePollerHealth({
    usageCircuitState: 'open',
    usageCircuitOpenedAt: now - 5 * 60_000, // 5 minutes ago
    consecutiveFailures: 6,
    backoffMs: 480_000,
    lastPollAt: now,
  });
  // ok:true is deliberate — the circuit's own open threshold (3 consecutive
  // failures) is LOWER than the old 5-failure WARN, so an ok:false YELLOW
  // would silently tighten the overall `npm run health` rollup's failure bar
  // from 5 down to 3. Graceful degradation must not itself read as critical.
  expect(result.ok).toBe(true);
  expect(result.color).toBe('YELLOW');
  expect(result.message).toMatch(/YELLOW/);
});

test('circuit open for AT LEAST FAILURE_STREAK_ESCALATION_MS (30 min) is RED — ok:false, this is the critical state', () => {
  const now = Date.now();
  const result = evaluateUsagePollerHealth({
    usageCircuitState: 'open',
    usageCircuitOpenedAt: now - FAILURE_STREAK_ESCALATION_MS,
    consecutiveFailures: 57,
    backoffMs: 480_000,
    lastPollAt: now,
  });
  expect(result.ok).toBe(false);
  expect(result.color).toBe('RED');
  expect(result.consecutiveFailures).toBe(57);
  expect(result.backoffMs).toBe(480_000);
  expect(result.message).toMatch(/RED/);
});

test('half_open (mid-probe) is treated the same as open — not GREEN just because a probe is in flight', () => {
  const now = Date.now();
  const result = evaluateUsagePollerHealth({
    usageCircuitState: 'half_open',
    usageCircuitOpenedAt: now - 60_000,
    consecutiveFailures: 5,
    lastPollAt: now,
  });
  expect(result.ok).toBe(true); // still YELLOW-shaped (under the red threshold), so still ok:true
  expect(result.color).toBe('YELLOW');
});

test('respects a custom redThresholdMs argument', () => {
  const now = Date.now();
  const openedAt = now - 10_000;
  const red = evaluateUsagePollerHealth({ usageCircuitState: 'open', usageCircuitOpenedAt: openedAt, consecutiveFailures: 5 }, 5_000);
  expect(red.color).toBe('RED');
  expect(red.ok).toBe(false);
  const yellow = evaluateUsagePollerHealth({ usageCircuitState: 'open', usageCircuitOpenedAt: openedAt, consecutiveFailures: 5 }, 60_000);
  expect(yellow.color).toBe('YELLOW');
  expect(yellow.ok).toBe(true);
});

test('tolerates a malformed/partial state object without throwing', () => {
  const result = evaluateUsagePollerHealth({});
  expect(result.ok).toBe(true);
  expect(result.color).toBe('GREEN');
  expect(result.consecutiveFailures).toBe(0);
});

// loadUsagePollerState: must distinguish "never ran" (ENOENT) from "corrupt"
// (unparseable) — the exact silent-masking bug class as the sibling
// scheduler-machine.json torn-write incident (f56bdc0), just for this sidecar.
// Uses a real scratch temp dir/file, never the real ~/.claude/session-manager/.
let scratchDir;
function makeScratchPath() {
  scratchDir = mkdtempSync(join(tmpdir(), 'sm-usage-poller-health-'));
  return join(scratchDir, 'scheduler-state.json');
}

test('loadUsagePollerState: missing file -> { missing: true }', () => {
  const p = join(makeScratchPath()); // never written
  const result = loadUsagePollerState(p);
  expect(result).toEqual({ missing: true });
  rmSync(scratchDir, { recursive: true, force: true });
});

test('loadUsagePollerState: corrupt/unparseable JSON -> errorMessage, not missing', () => {
  const p = makeScratchPath();
  writeFileSync(p, '{ not: valid json', 'utf8');
  const result = loadUsagePollerState(p);
  expect(result.missing).toBeUndefined();
  expect(result.state).toBeUndefined();
  expect(result.errorMessage).toMatch(/corrupt/);
  rmSync(scratchDir, { recursive: true, force: true });
});

test('loadUsagePollerState: valid JSON -> { state }', () => {
  const p = makeScratchPath();
  writeFileSync(p, JSON.stringify({ consecutiveFailures: 12, backoffMs: 480_000, lastPollAt: 123 }), 'utf8');
  const result = loadUsagePollerState(p);
  expect(result.state).toEqual({ consecutiveFailures: 12, backoffMs: 480_000, lastPollAt: 123 });
  rmSync(scratchDir, { recursive: true, force: true });
});

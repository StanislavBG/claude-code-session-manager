/**
 * health-usage-poller.test.cjs — `npm run health` must report non-GREEN when
 * the usage/rate-limit poller's (scheduler.cjs pollLoop) consecutiveFailures
 * streak, persisted to ~/.claude/session-manager/scheduler-state.json,
 * reaches FAILURE_STREAK_WARN_THRESHOLD — the SAME count that gates the
 * one-time opsErrorLog WARN (rateLimitPollerStreak.test.cjs shouldWarnFailureStreak
 * fires at `>= threshold`), so the log line and the health-GREEN flip happen
 * on the exact same failure, not one apart. Exercises evaluateUsagePollerHealth()
 * and loadUsagePollerState() directly since both are pure/file-scoped, matching
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
const { FAILURE_STREAK_WARN_THRESHOLD } = require('../scheduler.cjs');

test('missing state (fresh install / poller never ran) is ok, not applicable', () => {
  expect(evaluateUsagePollerHealth(null)).toEqual({ ok: true, applicable: false });
  expect(evaluateUsagePollerHealth(undefined)).toEqual({ ok: true, applicable: false });
});

test('consecutiveFailures below the threshold is GREEN', () => {
  const result = evaluateUsagePollerHealth({ consecutiveFailures: FAILURE_STREAK_WARN_THRESHOLD - 1, backoffMs: 240_000, lastPollAt: Date.now() });
  expect(result.ok).toBe(true);
  expect(result.applicable).toBe(true);
  expect(result.message).toBeUndefined();
});

test('consecutiveFailures AT the threshold is already non-GREEN — same count the WARN fires at', () => {
  // Must match shouldWarnFailureStreak's `>= threshold` exactly (scheduler.cjs)
  // so the opsErrorLog WARN and this health flip happen on the same failure.
  const result = evaluateUsagePollerHealth({ consecutiveFailures: FAILURE_STREAK_WARN_THRESHOLD, backoffMs: 480_000, lastPollAt: Date.now() });
  expect(result.ok).toBe(false);
  expect(result.message).toMatch(new RegExp(`${FAILURE_STREAK_WARN_THRESHOLD} consecutive failures`));
});

test('consecutiveFailures well past the threshold is non-GREEN with a diagnostic message', () => {
  const result = evaluateUsagePollerHealth({ consecutiveFailures: 57, backoffMs: 480_000, lastPollAt: Date.now() });
  expect(result.ok).toBe(false);
  expect(result.consecutiveFailures).toBe(57);
  expect(result.backoffMs).toBe(480_000);
  expect(result.message).toMatch(/57 consecutive failures/);
});

test('respects a custom threshold argument', () => {
  expect(evaluateUsagePollerHealth({ consecutiveFailures: 3 }, 3).ok).toBe(false);
  expect(evaluateUsagePollerHealth({ consecutiveFailures: 2 }, 3).ok).toBe(true);
});

test('tolerates a malformed/partial state object without throwing', () => {
  const result = evaluateUsagePollerHealth({});
  expect(result.ok).toBe(true);
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

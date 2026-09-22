/**
 * schedulerStateSidecarRestore.test.cjs — covers PRD 1392: scheduler-state.json
 * previously left lastPollOk, lastFailureKind, backoffNextAt, cachedUtilization and
 * cachedBindingWindowName memory-only, so a fresh boot showed misleading footer/KPI
 * placeholders (a healthy poller reading "failed", a still-rate-limited state
 * un-showable, utilization stuck at "—") until the next post-boot billing poll
 * overwrote them. Proves loadSchedulerState() restores all five from disk instead of
 * leaving the hardcoded defaults (false / null / null / null / null) in place.
 *
 * scheduler.cjs is a plain CJS require (like rateLimitPollerStreak.test.cjs's), so its
 * module-level `let`s are a singleton for this test file's process — the first test
 * below captures the pre-load snapshot itself (the hardcoded defaults) rather than
 * assuming a fresh module per test, so the proof doesn't depend on test ordering.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/schedulerStateSidecarRestore.test.cjs
 */

'use strict';

import { test, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const { loadSchedulerState, persistSchedulerState, getSchedulerStateSnapshot } = require('../scheduler.cjs');
const schedulerPaths = require('../lib/schedulerPaths.cjs');

function writeSidecar(data) {
  fs.mkdirSync(path.dirname(schedulerPaths.schedulerStatePath()), { recursive: true });
  fs.writeFileSync(schedulerPaths.schedulerStatePath(), JSON.stringify(data));
}

beforeEach(() => {
  try { fs.unlinkSync(schedulerPaths.schedulerStatePath()); } catch { /* no sidecar yet */ }
});

test('loadSchedulerState restores lastPollOk/lastFailureKind/backoffNextAt/cachedUtilization/cachedBindingWindowName from the sidecar, not the hardcoded defaults', () => {
  // Before a restore, the module starts (or was left, by whatever ran before this test
  // in-process) at whatever it was — capture it so the assertion below is a genuine
  // "changed to match the file" proof, not an assumption about fresh-module defaults.
  const before = getSchedulerStateSnapshot();

  const written = {
    version: 1,
    lastPollOk: true,
    lastFailureKind: 'meter_rate_limited',
    backoffNextAt: 1_726_000_000_000,
    cachedUtilization: 42,
    cachedBindingWindowName: 'five_hour',
  };
  writeSidecar(written);

  // Simulate a restart: a fresh process starts from the hardcoded module defaults
  // (false / null / null / null / null) until loadSchedulerState() runs.
  loadSchedulerState();

  const after = getSchedulerStateSnapshot();
  expect(after).toEqual({
    lastPollOk: true,
    lastFailureKind: 'meter_rate_limited',
    backoffNextAt: 1_726_000_000_000,
    cachedUtilization: 42,
    cachedBindingWindowName: 'five_hour',
  });
  // The restore must have actually changed something relative to the pre-load
  // snapshot — proves this run exercised the restore path, not a no-op.
  expect(after).not.toEqual(before);
});

test('persistSchedulerState writes the same five fields back out, round-tripping through the sidecar', () => {
  writeSidecar({
    version: 1,
    lastPollOk: false,
    lastFailureKind: 'auth',
    backoffNextAt: 1_726_100_000_000,
    cachedUtilization: 87.5,
    cachedBindingWindowName: 'weekly_all',
  });
  loadSchedulerState();

  persistSchedulerState();

  const onDisk = JSON.parse(fs.readFileSync(schedulerPaths.schedulerStatePath(), 'utf8'));
  expect(onDisk.lastPollOk).toBe(false);
  expect(onDisk.lastFailureKind).toBe('auth');
  expect(onDisk.backoffNextAt).toBe(1_726_100_000_000);
  expect(onDisk.cachedUtilization).toBe(87.5);
  expect(onDisk.cachedBindingWindowName).toBe('weekly_all');
});

test('loadSchedulerState against a sidecar missing the five fields leaves the in-memory values unchanged (pre-PRD-1392 file)', () => {
  // Establish a known non-default in-memory state first.
  writeSidecar({
    version: 1,
    lastPollOk: true,
    lastFailureKind: 'transient',
    backoffNextAt: 5000,
    cachedUtilization: 10,
    cachedBindingWindowName: 'seven_day',
  });
  loadSchedulerState();
  const established = getSchedulerStateSnapshot();

  // A sidecar written before PRD 1392 (or first-boot with only the older fields) has
  // none of the five new keys — loadSchedulerState's per-field `typeof` guards must
  // leave whatever was already in memory alone, not stomp it back to a hardcoded default.
  writeSidecar({ version: 1, lastPollAt: 123 });
  loadSchedulerState();

  expect(getSchedulerStateSnapshot()).toEqual(established);
});

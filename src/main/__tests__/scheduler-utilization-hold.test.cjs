/**
 * scheduler-utilization-hold.test.cjs — the tick (tickBody, the hold's owner)
 * holds on a window over threshold and records a machine-readable hold
 * (window/percent/threshold/reset) on the snapshot; under threshold it
 * dispatches. maybeLaunchWhenAvailable only ticks.
 * Run: timeout 180 npx vitest run src/main/__tests__/scheduler-utilization-hold.test.cjs
 */
'use strict';

import { test, expect, beforeAll, afterAll, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let tmpHome;
let originalHome;
let scheduler;
let billing;
let originalFetchUsage;

beforeAll(() => {
  originalHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-utilhold-'));
  process.env.HOME = tmpHome;
  fs.mkdirSync(path.join(tmpHome, '.claude', 'session-manager'), { recursive: true });
  fs.mkdirSync(path.join(tmpHome, '.claude', 'projects'), { recursive: true });
  scheduler = require('../scheduler.cjs');
  billing = require('../usage.cjs');
  originalFetchUsage = billing.fetchUsage;
});

afterAll(() => {
  billing.fetchUsage = originalFetchUsage;
  process.env.HOME = originalHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

afterEach(() => { billing.fetchUsage = originalFetchUsage; });

// Relative to now: a reset in the past no longer holds. Past one week out the
// pro-rated threshold (utilizationHold.proRatedThreshold) stays at the 90 base.
const RESET = new Date(Date.now() + 7 * 86_400_000 + 3_600_000).toISOString();
const SESSION_RESET = new Date(Date.now() + 2 * 3_600_000).toISOString();
function usageWith(weeklyPct) {
  return {
    kind: 'ok',
    data: {
      usage: {
        five_hour: { utilization: 10, resets_at: SESSION_RESET },
        limits: [
          { kind: 'session', percent: 10, scope: null, resets_at: SESSION_RESET },
          { kind: 'weekly_all', percent: weeklyPct, scope: null, resets_at: RESET },
        ],
      },
    },
  };
}

// dependsOn never resolves so a tick reaches the picker (stamping
// lastDispatchAttemptAt) without ever spawning a real job.
function state() {
  return {
    config: { firePolicy: 'when-available', utilizationThreshold: 90 },
    paused: null,
    jobs: [{ slug: '9002-hold', title: 'x', cwd: tmpHome, status: 'pending', dependsOn: ['never'] }],
  };
}

test('the tick holds and records the hold when the weekly window is over threshold; the line logs once', async () => {
  billing.fetchUsage = async () => usageWith(91);
  await scheduler.refreshNextReset();
  const logs = [];
  const orig = console.log;
  console.log = (...a) => { logs.push(a.join(' ')); };
  let r1;
  let r2;
  try {
    r1 = await scheduler.tickQueue();
    r2 = await scheduler.tickQueue();
  } finally { console.log = orig; }
  expect(r1).toMatchObject({ fired: false, reason: 'utilization-held' });
  expect(r2).toMatchObject({ fired: false, reason: 'utilization-held' });
  const payload = scheduler.buildScheduleStatePayload(state());
  expect(payload.utilizationHold).toEqual({ window: 'weekly_all', percent: 91, threshold: 90, resetsAt: RESET });
  expect(payload.utilizationWindow).toBe('weekly_all');
  // Written when the hold starts, not on every tick.
  expect(logs.filter((l) => l.includes('utilization-held') && l.includes('weekly_all')).length).toBe(1);
});

test('maybeLaunchWhenAvailable no longer holds itself: it ticks and the tick holds', async () => {
  billing.fetchUsage = async () => usageWith(91);
  await scheduler.refreshNextReset();
  const logs = [];
  const orig = console.log;
  console.log = (...a) => { logs.push(a.join(' ')); };
  try {
    await scheduler.maybeLaunchWhenAvailable(state());
    await scheduler.tickQueue();
  } finally { console.log = orig; }
  expect(logs.some((l) => l.includes('— ticking'))).toBe(true);
  expect(scheduler.buildScheduleStatePayload(state()).utilizationHold).toMatchObject({ window: 'weekly_all', percent: 91 });
});

test('ticks and clears the hold when the binding window is under threshold (weekly_all 64)', async () => {
  billing.fetchUsage = async () => usageWith(64);
  await scheduler.refreshNextReset();
  const logs = [];
  const orig = console.log;
  console.log = (...a) => { logs.push(a.join(' ')); };
  try { await scheduler.maybeLaunchWhenAvailable(state()); } finally { console.log = orig; }
  await scheduler.tickQueue();
  expect(scheduler.buildScheduleStatePayload(state()).utilizationHold).toBeNull();
  expect(logs.some((l) => l.includes('— ticking'))).toBe(true);
});

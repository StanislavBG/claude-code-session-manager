/**
 * scheduler-utilization-hold.test.cjs — the when-available gate holds on the
 * BINDING window and records a machine-readable hold (window/percent/
 * threshold/reset) on the snapshot; under threshold it dispatches.
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

const RESET = '2026-09-24T17:00:00Z';
function usageWith(weeklyPct) {
  return {
    kind: 'ok',
    data: {
      usage: {
        five_hour: { utilization: 10, resets_at: '2026-09-21T20:00:00Z' },
        limits: [
          { kind: 'session', percent: 10, scope: null, resets_at: '2026-09-21T20:00:00Z' },
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

test('holds (no tick) and records the hold when the binding weekly window is over threshold', async () => {
  billing.fetchUsage = async () => usageWith(91);
  await scheduler.refreshNextReset();
  const logs = [];
  const orig = console.log;
  console.log = (...a) => { logs.push(a.join(' ')); };
  try { await scheduler.maybeLaunchWhenAvailable(state()); } finally { console.log = orig; }
  const payload = scheduler.buildScheduleStatePayload(state());
  expect(payload.utilizationHold).toEqual({ window: 'weekly_all', percent: 91, threshold: 90, resetsAt: RESET });
  expect(payload.utilizationWindow).toBe('weekly_all');
  expect(logs.some((l) => l.includes('utilization-held') && l.includes('weekly_all'))).toBe(true);
  expect(logs.some((l) => l.includes('— ticking'))).toBe(false);
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

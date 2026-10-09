/**
 * scheduler-meter-429-dispatch.test.cjs — a 429 from the usage METER says
 * nothing about the account's usage. A recent cached reading is trusted (full
 * slot pool, hold only if the cache itself is over threshold); no/old cache
 * keeps the conservative degraded budget (cap 2). Live incident 2026-10-09:
 * real usage 1%/9% but the 429 pinned utilization to 100% until the weekly reset.
 * Run: timeout 180 npx vitest run src/main/__tests__/scheduler-meter-429-dispatch.test.cjs
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
let circuit;
let originalFetchUsage;

beforeAll(() => {
  originalHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-meter429-'));
  process.env.HOME = tmpHome;
  fs.mkdirSync(path.join(tmpHome, '.claude', 'session-manager'), { recursive: true });
  fs.mkdirSync(path.join(tmpHome, '.claude', 'projects'), { recursive: true });
  scheduler = require('../scheduler.cjs');
  billing = require('../usage.cjs');
  circuit = require('../lib/usageCircuit.cjs');
  originalFetchUsage = billing.fetchUsage;
});

afterAll(() => {
  billing.fetchUsage = originalFetchUsage;
  process.env.HOME = originalHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

afterEach(() => { billing.fetchUsage = originalFetchUsage; });

const WEEKLY_RESET = new Date(Date.now() + 6 * 86_400_000).toISOString();
function payload(weeklyPct) {
  return {
    five_hour: { utilization: 1, resets_at: new Date(Date.now() + 3_600_000).toISOString() },
    limits: [
      { kind: 'session', percent: 1, scope: null, resets_at: new Date(Date.now() + 3_600_000).toISOString() },
      { kind: 'weekly_all', percent: weeklyPct, scope: null, resets_at: WEEKLY_RESET },
    ],
  };
}

function state() {
  return {
    config: { firePolicy: 'when-available', utilizationThreshold: 90 },
    paused: null,
    jobs: [{ slug: '9003-meter429', title: 'x', cwd: tmpHome, status: 'pending', dependsOn: ['never'] }],
  };
}

async function pollWith429(extra) {
  billing.fetchUsage = async () => ({ kind: 'meter_rate_limited', message: '429', httpStatus: 429, ...extra });
  const logs = [];
  const orig = console.log;
  console.log = (...a) => { logs.push(a.join(' ')); };
  try {
    await scheduler.pollLoop();
    await scheduler.tickQueue();
  } finally { console.log = orig; }
  return logs;
}

test('(a) 429 with a 5-minute-old cache at 9% → not held, full pool (cap null)', async () => {
  const logs = await pollWith429({ cached: payload(9), staleSince: Date.now() - 5 * 60_000 });
  expect(logs.some((l) => l.includes('cached budget') && l.includes('cap=null'))).toBe(true);
  expect(logs.some((l) => l.includes('utilization-held'))).toBe(false);
  expect(scheduler.buildScheduleStatePayload(state()).utilizationHold).toBeNull();
});

test('(c) 429 with cache at 95% → held on the cached utilization', async () => {
  const logs = await pollWith429({ cached: payload(95), staleSince: Date.now() - 60_000 });
  expect(logs.some((l) => l.includes('cached budget') && l.includes('cap=null'))).toBe(true);
  const held = [];
  const orig = console.log;
  console.log = (...a) => { held.push(a.join(' ')); };
  try { await scheduler.maybeLaunchWhenAvailable(state()); } finally { console.log = orig; }
  expect(held.some((l) => l.includes('utilization-held') && l.includes('weekly_all'))).toBe(true);
  expect(scheduler.buildScheduleStatePayload(state()).utilizationHold).toMatchObject({ window: 'weekly_all', percent: 95 });
});

test('(b) 429 with no cache → degraded budget (cap 2), never a weekly-reset pin to 100 from the 429 alone', async () => {
  const logs = await pollWith429({});
  expect(logs.some((l) => l.includes('degraded budget') && l.includes('cap=2'))).toBe(true);
  expect(logs.some((l) => l.includes('retry in'))).toBe(true);
});

test('429 with a cache older than 30 minutes → degraded budget (cap 2)', async () => {
  const logs = await pollWith429({ cached: payload(9), staleSince: Date.now() - 31 * 60_000 });
  expect(logs.some((l) => l.includes('degraded budget') && l.includes('cap=2'))).toBe(true);
});

test('(d) meterFailureBudget: fresh cache → cached utilization; old/absent → null', () => {
  const now = Date.now();
  expect(circuit.meterFailureBudget({ cachedPayload: payload(9), staleSinceMs: now - 60_000, now })).toMatchObject({ utilization: 9, degraded: false });
  expect(circuit.meterFailureBudget({ cachedPayload: payload(9), staleSinceMs: now - 31 * 60_000, now })).toBeNull();
  expect(circuit.meterFailureBudget({ cachedPayload: null, staleSinceMs: now, now })).toBeNull();
  expect(circuit.meterFailureBudget({ cachedPayload: payload(9), staleSinceMs: undefined, now })).toBeNull();
});

test('(d) degradedBudget no longer pins to 100 without executor evidence', () => {
  const b = circuit.degradedBudget(payload(9), { observed429: false, resetsAt: WEEKLY_RESET, now: Date.now(), configuredCap: 10 });
  expect(b).toEqual({ utilization: 9, concurrencyCap: 2 });
  const pinned = circuit.degradedBudget(payload(9), { observed429: true, resetsAt: WEEKLY_RESET, now: Date.now(), configuredCap: 10 });
  expect(pinned.utilization).toBe(100);
});

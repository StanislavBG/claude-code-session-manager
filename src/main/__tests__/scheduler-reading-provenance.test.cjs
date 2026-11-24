/**
 * scheduler-reading-provenance.test.cjs — utilizationReading() tells a real
 * reading apart from the 100% "no reading ever" placeholder, keeps the last
 * real reading while the meter is down, and carries EVERY unscoped window of
 * that reading (not only the binding one) — across a restart too — so the
 * hold rule can skip a window that reset mid-outage and keep holding on
 * weekly_all (Self, 2026-11-23).
 *
 * Run: timeout 180 npx vitest run src/main/__tests__/scheduler-reading-provenance.test.cjs
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
let schedulerPaths;
let originalFetchUsage;
let originalApplicable;

beforeAll(() => {
  originalHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-reading-prov-'));
  process.env.HOME = tmpHome;
  fs.mkdirSync(path.join(tmpHome, '.claude', 'session-manager'), { recursive: true });
  fs.mkdirSync(path.join(tmpHome, '.claude', 'projects'), { recursive: true });
  scheduler = require('../scheduler.cjs');
  billing = require('../usage.cjs');
  schedulerPaths = require('../lib/scheduler/schedulerPaths.cjs');
  originalFetchUsage = billing.fetchUsage;
  originalApplicable = billing.usageMeterApplicable;
  billing.usageMeterApplicable = () => true;
});

afterAll(() => {
  billing.fetchUsage = originalFetchUsage;
  billing.usageMeterApplicable = originalApplicable;
  process.env.HOME = originalHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

afterEach(() => {
  billing.fetchUsage = originalFetchUsage;
  billing.usageMeterApplicable = () => true;
});

async function pollWith(result) {
  billing.fetchUsage = async () => result;
  const orig = console.log;
  console.log = () => {};
  try { await scheduler.pollLoop(); } finally { console.log = orig; }
}

const iso = (deltaMs) => new Date(Date.now() + deltaMs).toISOString();

function weeklyPayload(weeklyPct) {
  return {
    five_hour: { utilization: 1, resets_at: iso(3_600_000) },
    limits: [
      { kind: 'session', percent: 1, scope: null, resets_at: iso(3_600_000) },
      { kind: 'weekly_all', percent: weeklyPct, scope: null, resets_at: iso(6 * 86_400_000) },
    ],
  };
}

function writeSidecar(data) {
  fs.mkdirSync(path.dirname(schedulerPaths.schedulerStatePath()), { recursive: true });
  fs.writeFileSync(schedulerPaths.schedulerStatePath(), JSON.stringify(data));
}

test('no reading ever: the degraded placeholder is 100 with known=false and no windows', async () => {
  await pollWith({ kind: 'meter_rate_limited', message: '429', httpStatus: 429 });
  expect(scheduler.utilizationReading()).toMatchObject({ percent: 100, known: false, windows: null });
});

test('stale cache on a meter 429 carries 96 / weekly_all / known=true with cap 2', async () => {
  await pollWith({ kind: 'meter_rate_limited', message: '429', httpStatus: 429, cached: weeklyPayload(96), staleSince: Date.now() - 31 * 60_000 });
  const r = scheduler.utilizationReading();
  expect(r).toMatchObject({ percent: 96, window: 'weekly_all', known: true });
  const hb = scheduler.heartbeatTick({ readQueueSync: () => ({ jobs: [], unreadable: true, paused: null }) });
  expect(hb.usageMeter.appliedConcurrencyCap).toBe(2);
});

test('a persisted known flag survives a restore; a file without it derives known from the number', () => {
  writeSidecar({ version: 1, cachedUtilization: 100, cachedBindingWindowName: 'five_hour', cachedUtilizationKnown: false });
  scheduler.loadSchedulerState();
  expect(scheduler.utilizationReading().known).toBe(false);

  writeSidecar({ version: 1, cachedUtilization: 77, cachedBindingWindowName: 'weekly_all', cachedUtilizationKnown: true });
  scheduler.loadSchedulerState();
  expect(scheduler.utilizationReading()).toMatchObject({ percent: 77, known: true });

  scheduler.persistSchedulerState();
  const onDisk = JSON.parse(fs.readFileSync(schedulerPaths.schedulerStatePath(), 'utf8'));
  expect(onDisk.cachedUtilizationKnown).toBe(true);

  writeSidecar({ version: 1, cachedUtilization: 50, cachedBindingWindowName: 'five_hour' });
  scheduler.loadSchedulerState();
  expect(scheduler.utilizationReading().known).toBe(true);
  writeSidecar({ version: 1, cachedUtilization: null, cachedBindingWindowName: null });
  scheduler.loadSchedulerState();
  expect(scheduler.utilizationReading().known).toBe(false);
});

test('a good poll exposes every unscoped window in payload order, and the list survives a restart', async () => {
  const sessionReset = iso(-60_000);
  const weeklyReset = iso(3 * 86_400_000);
  await pollWith({
    kind: 'ok',
    data: {
      usage: {
        five_hour: { utilization: 97, resets_at: sessionReset },
        limits: [
          { kind: 'session', percent: 97, scope: null, resets_at: sessionReset },
          { kind: 'weekly_all', percent: 92, scope: null, resets_at: weeklyReset },
        ],
      },
    },
  });
  const expected = [
    { window: 'session', percent: 97, resetsAt: sessionReset },
    { window: 'weekly_all', percent: 92, resetsAt: weeklyReset },
  ];
  const r = scheduler.utilizationReading();
  expect(r).toMatchObject({ percent: 97, window: 'session', known: true });
  expect(r.windows).toEqual(expected);

  scheduler.persistSchedulerState();
  // Restart: a fresh module instance holds no payload until loadSchedulerState().
  delete require.cache[require.resolve('../scheduler.cjs')];
  scheduler = require('../scheduler.cjs');
  expect(scheduler.utilizationReading().windows).toBeNull();
  scheduler.loadSchedulerState();
  const restored = scheduler.utilizationReading();
  expect(restored.windows).toEqual(expected);
  expect(restored.known).toBe(true);
});

test('a malformed persisted windows list restores null', () => {
  writeSidecar({ version: 1, cachedUtilization: 10, usageWindows: [{ window: 'session', percent: 'x' }] });
  scheduler.loadSchedulerState();
  expect(scheduler.utilizationReading().windows).toBeNull();
});

test('the no-meter (enterprise) branch leaves windows null', async () => {
  writeSidecar({ version: 1, cachedUtilization: 92, cachedUtilizationKnown: true, usageWindows: [{ window: 'weekly_all', percent: 92, resetsAt: iso(86_400_000) }] });
  scheduler.loadSchedulerState();
  expect(scheduler.utilizationReading().windows).toHaveLength(1);
  billing.usageMeterApplicable = () => false;
  await pollWith({ kind: 'ok', data: { usage: weeklyPayload(92) } });
  const r = scheduler.utilizationReading();
  expect(r.windows).toBeNull();
  expect(r).toMatchObject({ percent: 0, known: true });
});

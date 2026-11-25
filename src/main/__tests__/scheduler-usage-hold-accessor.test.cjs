/**
 * scheduler-usage-hold-accessor.test.cjs — currentUsageHold() and
 * usageHoldThreshold(): the scheduler's utilization rule, read synchronously
 * at the saved 'pause above' threshold, for callers outside the PRD queue
 * (POST /admin/tasks, its timers, outside read routes). firePolicy never
 * applies — it is the PRD queue's own setting.
 *
 * Harness copied from scheduler-auto-dispatch-hold.test.cjs (tmp HOME).
 * Run: timeout 180 npx vitest run src/main/__tests__/scheduler-usage-hold-accessor.test.cjs
 */
'use strict';

import { test, expect, beforeAll, afterEach, afterAll, vi } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// A weekly reset a full week ahead keeps the pro-rated cap at the saved base
// (proRatedThreshold: f >= 1 -> base). The extra hour keeps f >= 1 after the
// milliseconds between building the fixture and reading it (and the 61 s
// half_open advance below); exactly 7 days would pro-rate to 90.0000x.
const WEEK_AHEAD = 7 * DAY + HOUR;

let tmpHome;
let originalHome;
let originalMeminfo;
let scheduler;
let billing;
let queueStore;
let originalFetchUsage;

function iso(offsetMs) { return new Date(Date.now() + offsetMs).toISOString(); }

function okUsage(limits) {
  const session = limits.find((l) => l.kind === 'session');
  return {
    kind: 'ok',
    data: { usage: { five_hour: session ? { utilization: session.percent, resets_at: session.resets_at } : undefined, limits } },
  };
}

function weekly(pct, resetIn = 3 * DAY) {
  return okUsage([
    { kind: 'session', percent: 10, resets_at: iso(2 * HOUR), scope: null },
    { kind: 'weekly_all', percent: pct, resets_at: iso(resetIn), scope: null },
  ]);
}

async function goodReading(usage) {
  billing.usageCircuit.recordSuccess({});
  billing.fetchUsage = async () => usage;
  await scheduler.refreshNextReset();
}

function openCircuit() {
  for (let i = 0; i < 3; i += 1) billing.usageCircuit.recordFailure('x');
  expect(billing.usageCircuit.state()).toBe('open');
}

async function setConfig(firePolicy, utilizationThreshold) {
  await scheduler._mutateForTests((s) => { s.config = { ...(s.config || {}), firePolicy, utilizationThreshold }; });
}

beforeAll(() => {
  originalHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-usage-hold-accessor-'));
  process.env.HOME = tmpHome;
  process.env.SM_JOB_WORKTREE_DISABLE = '1';
  process.env.SM_AUTOFIX_DISABLE = '1';
  process.env.SM_CLAUDE_VERSION = '2.0.0-test';
  fs.mkdirSync(path.join(tmpHome, '.claude', 'session-manager'), { recursive: true });
  fs.mkdirSync(path.join(tmpHome, '.claude', 'projects'), { recursive: true });
  originalMeminfo = process.env.SM_MEMINFO_PATH;
  const ample = path.join(tmpHome, 'meminfo-64gb');
  fs.writeFileSync(ample, 'MemAvailable:    67108864 kB\nSwapTotal:             0 kB\nSwapFree:              0 kB\n');
  process.env.SM_MEMINFO_PATH = ample;
  scheduler = require('../scheduler.cjs');
  billing = require('../usage.cjs');
  queueStore = require('../lib/scheduler/queueStore.cjs');
  originalFetchUsage = billing.fetchUsage;
});

afterEach(() => {
  billing.fetchUsage = originalFetchUsage;
  vi.useRealTimers();
});

afterAll(() => {
  billing.fetchUsage = originalFetchUsage;
  if (originalMeminfo === undefined) delete process.env.SM_MEMINFO_PATH;
  else process.env.SM_MEMINFO_PATH = originalMeminfo;
  delete process.env.SM_JOB_WORKTREE_DISABLE;
  delete process.env.SM_AUTOFIX_DISABLE;
  delete process.env.SM_CLAUDE_VERSION;
  process.env.HOME = originalHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

test('before any reading: reading unknown, no hold, default threshold, no machine config', () => {
  expect(scheduler.utilizationReading().known).toBe(false);
  expect(scheduler.currentUsageHold()).toBeNull();
  expect(queueStore.readMachineConfigSync()).toEqual({});
  expect(scheduler.usageHoldThreshold()).toBe(90);
});

test('readMachineConfigSync returns the saved config once _mutateForTests writes the machine file', async () => {
  await setConfig('when-available', 90);
  expect(queueStore.readMachineConfigSync()).toMatchObject({ firePolicy: 'when-available', utilizationThreshold: 90 });
});

test('weekly_all 92% at threshold 90 holds; 80% does not', async () => {
  await setConfig('when-available', 90);
  await goodReading(weekly(92, WEEK_AHEAD));
  const hold = scheduler.currentUsageHold();
  expect(hold).toMatchObject({ reason: 'utilization-held', window: 'weekly_all', percent: 92, threshold: 90 });
  expect(typeof hold.resetsAt).toBe('string');
  await goodReading(weekly(80));
  expect(scheduler.currentUsageHold()).toBeNull();
});

test('weekly_all 92% resetting 41 h ahead at threshold 90 gives no hold (pro-rated cap 99)', async () => {
  await setConfig('when-available', 90);
  await goodReading(weekly(92, 41 * HOUR));
  expect(scheduler.usageHoldThreshold()).toBe(90);
  expect(scheduler.currentUsageHold()).toBeNull();
});

test('a saved threshold of 95 with 92% gives no hold', async () => {
  await setConfig('when-available', 95);
  expect(scheduler.usageHoldThreshold()).toBe(95);
  await goodReading(weekly(92));
  expect(scheduler.currentUsageHold()).toBeNull();
  await setConfig('when-available', 90);
});

test('an open circuit after a good 92% reading still holds; so does a failed half_open probe', async () => {
  await setConfig('when-available', 90);
  await goodReading(weekly(92, WEEK_AHEAD));
  openCircuit();
  billing.fetchUsage = async () => { throw new Error('fetch must not run while the circuit is open'); };
  await scheduler.pollLoop();
  expect(scheduler.currentUsageHold()).toMatchObject({ reason: 'utilization-held', percent: 92 });

  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.now() + 61_000);
  expect(billing.usageCircuit.state()).toBe('half_open');
  billing.fetchUsage = async () => {
    billing.usageCircuit.recordFailure('probe');
    return { kind: 'transient', message: 'probe failed' };
  };
  await scheduler.pollLoop();
  expect(billing.usageCircuit.state()).toBe('open');
  expect(scheduler.currentUsageHold()).toMatchObject({ reason: 'utilization-held', percent: 92 });
});

test("firePolicy 'manual' at 10% gives no hold (firePolicy never applies)", async () => {
  vi.useRealTimers();
  billing.usageCircuit.recordSuccess({});
  await goodReading(weekly(10));
  await setConfig('manual', 90);
  expect(scheduler.currentUsageHold()).toBeNull();
  await setConfig('when-available', 90);
});

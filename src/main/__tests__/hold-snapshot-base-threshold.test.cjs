/**
 * hold-snapshot-base-threshold.test.cjs — the hold snapshots scheduler.cjs
 * builds carry the base 'pause above' next to the pro-rated threshold
 * (PRD 4533), so the heartbeat shows both.
 * Run: timeout 180 npx vitest run src/main/__tests__/hold-snapshot-base-threshold.test.cjs
 */
'use strict';

import { test, expect, beforeAll, afterAll } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let tmpHome;
let originalHome;
let scheduler;
let billing;
let schedulerPaths;
let originalFetchUsage;

beforeAll(() => {
  originalHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-holdbase-'));
  process.env.HOME = tmpHome;
  fs.mkdirSync(path.join(tmpHome, '.claude', 'session-manager'), { recursive: true });
  fs.mkdirSync(path.join(tmpHome, '.claude', 'projects'), { recursive: true });
  scheduler = require('../scheduler.cjs');
  billing = require('../usage.cjs');
  schedulerPaths = require('../lib/scheduler/schedulerPaths.cjs');
  originalFetchUsage = billing.fetchUsage;
});

afterAll(() => {
  billing.fetchUsage = originalFetchUsage;
  process.env.HOME = originalHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

test('weekly_all 100% held 41 h before reset: heartbeat utilizationHold carries the PRO_RATE_CEILING threshold and baseThreshold 90', async () => {
  const { PRO_RATE_CEILING } = require('../scheduler/utilizationHold.cjs');
  const reset = new Date(Date.now() + 41 * 3_600_000).toISOString();
  const sessionReset = new Date(Date.now() + 2 * 3_600_000).toISOString();
  billing.fetchUsage = async () => ({
    kind: 'ok',
    data: {
      usage: {
        five_hour: { utilization: 10, resets_at: sessionReset },
        limits: [
          { kind: 'session', percent: 10, scope: null, resets_at: sessionReset },
          { kind: 'weekly_all', percent: 100, scope: null, resets_at: reset },
        ],
      },
    },
  });
  await scheduler.refreshNextReset();
  const r = await scheduler.tickQueue();
  expect(r).toMatchObject({ fired: false, reason: 'utilization-held' });

  const hbPath = schedulerPaths.heartbeatPath();
  fs.mkdirSync(path.dirname(hbPath), { recursive: true });
  const entry = scheduler.heartbeatTick({ readQueueSync: () => ({ jobs: [], unreadable: true, paused: null }) });
  expect(entry.utilizationHold).toMatchObject({ window: 'weekly_all', percent: 100, threshold: PRO_RATE_CEILING, baseThreshold: 90 });
  const line = JSON.parse(fs.readFileSync(hbPath, 'utf8').trim().split('\n').pop());
  expect(line.utilizationHold).toMatchObject({ threshold: PRO_RATE_CEILING, baseThreshold: 90 });
});

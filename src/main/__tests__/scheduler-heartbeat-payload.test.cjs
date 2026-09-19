/**
 * scheduler-heartbeat-payload.test.cjs — the heartbeat line carries build
 * identity, a subsystem throw yields a `degraded: true` line, and both
 * watchdogHelpers.heartbeatFresh and health.readFreshHeartbeat treat a
 * degraded line as NOT fresh.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/scheduler-heartbeat-payload.test.cjs
 */
'use strict';

import { test, expect, beforeEach, vi } from 'vitest';
const fs = require('node:fs');
const schedulerPaths = require('../lib/schedulerPaths.cjs');
const scheduler = require('../scheduler.cjs');
const { heartbeatFresh } = require('../lib/watchdogHelpers.cjs');
const { readFreshHeartbeat } = require('../health.cjs');

const HB = () => schedulerPaths.heartbeatPath();
const lastLine = () => JSON.parse(fs.readFileSync(HB(), 'utf8').trim().split('\n').pop());

beforeEach(() => {
  fs.mkdirSync(require('node:path').dirname(HB()), { recursive: true });
  fs.rmSync(HB(), { force: true });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

test('healthy tick writes build {version, codeSha, builtAt} and is fresh', () => {
  const entry = scheduler.heartbeatTick({ readQueueSync: () => ({ jobs: [], unreadable: true, paused: null }) });
  expect(entry.degraded).toBeUndefined();
  const line = lastLine();
  expect(line.build).toEqual(expect.objectContaining({ version: expect.anything() }));
  expect(Object.keys(line.build).sort()).toEqual(['builtAt', 'codeSha', 'version']);
  expect(line.counts).toBeDefined();
  expect(heartbeatFresh(HB())).toBe(true);
  expect(readFreshHeartbeat(HB())).not.toBeNull();
});

test('a throwing queue read writes a degraded line with the error, never a fresh one', () => {
  scheduler.heartbeatTick({ readQueueSync: () => { throw new Error('boom-queue'); } });
  const line = lastLine();
  expect(line.degraded).toBe(true);
  expect(line.errors[0]).toEqual({ subsystem: 'queue-read-starvation-watchdog', error: 'boom-queue' });
  expect(line.build).toBeDefined();
  expect(line.utilization).toBeUndefined();
  expect(heartbeatFresh(HB())).toBe(false);
  expect(readFreshHeartbeat(HB())).toBeNull();
});

test('a throw in the stall detector degrades the line too', () => {
  scheduler.heartbeatTick({ readQueueSync: () => ({ jobs: null, unreadable: true, paused: null }) });
  const line = lastLine();
  expect(line.degraded).toBe(true);
  expect(line.errors.some((e) => e.subsystem === 'stall-detector' || e.subsystem === 'heartbeat-write')).toBe(true);
  expect(heartbeatFresh(HB())).toBe(false);
});

test('watchdogHelpers treats a hand-written degraded line as stale', () => {
  fs.writeFileSync(HB(), JSON.stringify({ ts: Date.now(), degraded: true }) + '\n');
  expect(heartbeatFresh(HB())).toBe(false);
  fs.writeFileSync(HB(), JSON.stringify({ ts: Date.now() }) + '\n');
  expect(heartbeatFresh(HB())).toBe(true);
});

test('healthy tick carries dispatch {..., pendingDispatchable excludes blocked chains}', () => {
  const jobs = [
    { slug: '1-a', cwd: '/p', status: 'failed' },
    { slug: '2-b', cwd: '/p', status: 'pending', dependsOn: ['1-a'] },
    { slug: '3-c', cwd: '/p', status: 'pending' },
  ];
  const entry = scheduler.heartbeatTick({
    readQueueSync: () => ({ jobs, unreadable: true, paused: null, lastRunAt: '2026-01-01T00:00:00.000Z' }),
  });
  expect(entry.dispatch).toEqual(expect.objectContaining({
    lastRunAt: '2026-01-01T00:00:00.000Z', pendingDispatchable: 1, runningCount: 0, paused: false,
  }));
  expect(Object.keys(entry.dispatch).sort()).toEqual(
    ['lastDispatchAttemptAt', 'lastRunAt', 'lastTickReason', 'paused', 'pendingDispatchable', 'runningCount'],
  );
});

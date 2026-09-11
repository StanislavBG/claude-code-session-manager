/**
 * telemetryCounters.test.cjs — unit tests for the single shared emission
 * point behind 'app.launch' / 'session.open' / 'epic.create' /
 * 'scheduler.job.finish'. Each real call site (pty.cjs, epicMint.cjs,
 * scheduleJobTransitions.cjs, telemetryBoot.cjs) delegates here, so this is
 * where the event name + prop-key shape is verified once.
 *
 * Run: timeout 120 npx vitest run src/main/lib/__tests__/telemetryCounters.test.cjs
 */
'use strict';

import { test, expect } from 'vitest';
const counters = require('../telemetryCounters.cjs');

function fakeClient() {
  const calls = [];
  return { calls, deps: { telemetryClient: { track: (name, props) => { calls.push({ name, props }); } } } };
}

test('trackAppLaunch fires app.launch once with installChannel + appVersion', () => {
  const { calls, deps } = fakeClient();
  counters.trackAppLaunch({ installChannel: 'npx', appVersion: '0.83.0' }, deps);
  expect(calls).toHaveLength(1);
  expect(calls[0].name).toBe('app.launch');
  expect(Object.keys(calls[0].props).sort()).toEqual(['appVersion', 'installChannel'].sort());
});

test('trackSessionOpen fires session.open once', () => {
  const { calls, deps } = fakeClient();
  counters.trackSessionOpen(deps);
  expect(calls).toHaveLength(1);
  expect(calls[0].name).toBe('session.open');
});

test('trackEpicCreate fires epic.create once', () => {
  const { calls, deps } = fakeClient();
  counters.trackEpicCreate(deps);
  expect(calls).toHaveLength(1);
  expect(calls[0].name).toBe('epic.create');
});

test('trackSchedulerJobFinish fires scheduler.job.finish once with a status-only prop', () => {
  const { calls, deps } = fakeClient();
  counters.trackSchedulerJobFinish({ status: 'completed' }, deps);
  expect(calls).toHaveLength(1);
  expect(calls[0].name).toBe('scheduler.job.finish');
  expect(Object.keys(calls[0].props)).toEqual(['status']);
  expect(calls[0].props.status).toBe('completed');
});

test('a throwing telemetryClient.track never escapes any counter function', () => {
  const deps = { telemetryClient: { track: () => { throw new Error('boom'); } } };
  expect(() => counters.trackAppLaunch({ installChannel: 'dev', appVersion: '1.0.0' }, deps)).not.toThrow();
  expect(() => counters.trackSessionOpen(deps)).not.toThrow();
  expect(() => counters.trackEpicCreate(deps)).not.toThrow();
  expect(() => counters.trackSchedulerJobFinish({ status: 'failed' }, deps)).not.toThrow();
});

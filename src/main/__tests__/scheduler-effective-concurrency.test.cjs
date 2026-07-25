/**
 * scheduler-effective-concurrency.test.cjs — unit tests for the
 * effectiveConcurrency field on buildScheduleStatePayload.
 *
 * Run: timeout 300 npx vitest run src/main/__tests__/scheduler-effective-concurrency.test.cjs
 */

'use strict';

import { test, expect, beforeEach, afterEach } from 'vitest';
const { buildScheduleStatePayload } = require('../scheduler.cjs');

const ENV_KEY = 'SM_SCHEDULER_MAX_CONCURRENCY';
let savedEnv;

beforeEach(() => {
  savedEnv = process.env[ENV_KEY];
  delete process.env[ENV_KEY];
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = savedEnv;
});

function fakeState(concurrencyCap) {
  return {
    config: { concurrencyCap },
    jobs: [],
    scheduledFor: null,
    lastRunAt: null,
    paused: null,
  };
}

test('effectiveConcurrency is config-sourced when env var is unset', () => {
  const payload = buildScheduleStatePayload(fakeState(5));
  expect(payload.effectiveConcurrency).toEqual({ cap: 5, source: 'config' });
});

test('effectiveConcurrency is env-sourced and wins over config when env var is set', () => {
  process.env[ENV_KEY] = '7';
  const payload = buildScheduleStatePayload(fakeState(5));
  expect(payload.effectiveConcurrency).toEqual({ cap: 7, source: 'env' });
});

test('effectiveConcurrency clamps env var into [1, 20]', () => {
  process.env[ENV_KEY] = '999';
  const payload = buildScheduleStatePayload(fakeState(5));
  expect(payload.effectiveConcurrency).toEqual({ cap: 20, source: 'env' });
});

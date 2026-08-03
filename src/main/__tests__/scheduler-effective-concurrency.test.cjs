/**
 * scheduler-effective-concurrency.test.cjs — unit tests for the
 * effectiveConcurrency field on buildScheduleStatePayload.
 *
 * The scheduler's private `concurrencyCap` is retired: the machine-wide
 * sessionSlots pool is the ONLY concurrency limit, so effectiveConcurrency
 * now reports the pool (and its SM_SESSION_SLOTS override), not a config
 * field. See lib/sessionSlots.cjs's charter — caps belong to Session-Manager,
 * not to each consumer.
 *
 * Run: timeout 300 npx vitest run src/main/__tests__/scheduler-effective-concurrency.test.cjs
 */

'use strict';

import { test, expect, beforeEach, afterEach } from 'vitest';
const { buildScheduleStatePayload } = require('../scheduler.cjs');
const sessionSlots = require('../lib/sessionSlots.cjs');

const ENV_KEY = 'SM_SESSION_SLOTS';
let savedEnv;

beforeEach(() => {
  savedEnv = process.env[ENV_KEY];
  delete process.env[ENV_KEY];
  sessionSlots.__resetForTests();
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = savedEnv;
  sessionSlots.__resetForTests();
});

function fakeState() {
  return {
    config: {},
    jobs: [],
    scheduledFor: null,
    lastRunAt: null,
    paused: null,
  };
}

test('effectiveConcurrency reports the pool when no env override is set', () => {
  const payload = buildScheduleStatePayload(fakeState());
  expect(payload.effectiveConcurrency.source).toBe('pool');
  expect(payload.effectiveConcurrency.cap).toBe(sessionSlots.totalSlots());
  expect(payload.effectiveConcurrency.free).toBe(sessionSlots.available());
});

test('effectiveConcurrency is env-sourced when SM_SESSION_SLOTS is set', () => {
  process.env[ENV_KEY] = '7';
  const payload = buildScheduleStatePayload(fakeState());
  expect(payload.effectiveConcurrency).toEqual({ cap: 7, free: 7, source: 'env' });
});

test('effectiveConcurrency clamps the env var into the pool range [0, 10]', () => {
  process.env[ENV_KEY] = '999';
  const payload = buildScheduleStatePayload(fakeState());
  expect(payload.effectiveConcurrency).toEqual({ cap: 10, free: 10, source: 'env' });
});

test('free is net of held slots — a chat run shrinks it without changing cap', () => {
  process.env[ENV_KEY] = '5';
  const token = sessionSlots.acquire('chat:test-tab');
  expect(token).toBeTruthy();
  const payload = buildScheduleStatePayload(fakeState());
  expect(payload.effectiveConcurrency).toEqual({ cap: 5, free: 4, source: 'env' });
  sessionSlots.release(token);
});

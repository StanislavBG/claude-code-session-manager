/**
 * epicStateWatchTick.test.cjs — runEpicStateWatchForTick, the scheduler tick's
 * best-effort adoption of lib/epic/epicStateWatcher.cjs.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/epicStateWatchTick.test.cjs
 */

'use strict';

import { test, expect, afterEach, vi } from 'vitest';
const { runEpicStateWatchForTick } = require('../scheduler.cjs');

const ENV = 'SM_EPIC_STATE_WATCH_DISABLE';
const saved = process.env[ENV];
afterEach(() => {
  if (saved === undefined) delete process.env[ENV];
  else process.env[ENV] = saved;
  vi.restoreAllMocks();
});

test('passes every project cwd and the state jobs to the watcher', async () => {
  delete process.env[ENV];
  const jobs = [{ id: 'j1' }];
  const watch = vi.fn(async () => ({ changes: [] }));
  await runEpicStateWatchForTick({ jobs }, { watch, listCwds: () => ['/a', '/b'] });
  expect(watch).toHaveBeenCalledTimes(1);
  expect(watch).toHaveBeenCalledWith({ cwds: ['/a', '/b'], jobs });
  expect(watch.mock.calls[0][0].jobs).toBe(jobs);
});

test('leaves a quarantined cwd out', async () => {
  delete process.env[ENV];
  const watch = vi.fn(async () => ({}));
  const state = { jobs: [], unreadableCwds: [{ cwd: '/b', error: 'bad shard' }] };
  await runEpicStateWatchForTick(state, { watch, listCwds: () => ['/a', '/b', '/c'] });
  expect(watch).toHaveBeenCalledWith({ cwds: ['/a', '/c'], jobs: [] });
});

test('SM_EPIC_STATE_WATCH_DISABLE=1 skips the watcher', async () => {
  process.env[ENV] = '1';
  const watch = vi.fn(async () => ({}));
  const listCwds = vi.fn(() => ['/a']);
  await runEpicStateWatchForTick({ jobs: [] }, { watch, listCwds });
  expect(watch).not.toHaveBeenCalled();
  expect(listCwds).not.toHaveBeenCalled();
});

test('a rejecting watcher does not throw into the caller', async () => {
  delete process.env[ENV];
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const watch = vi.fn(async () => { throw new Error('boom'); });
  await expect(runEpicStateWatchForTick({ jobs: [] }, { watch, listCwds: () => ['/a'] })).resolves.toBeUndefined();
  expect(watch).toHaveBeenCalledTimes(1);
  expect(warn).toHaveBeenCalled();
});

test('a throwing cwd list does not throw into the caller', async () => {
  delete process.env[ENV];
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const watch = vi.fn(async () => ({}));
  await expect(runEpicStateWatchForTick({ jobs: [] }, { watch, listCwds: () => { throw new Error('x'); } })).resolves.toBeUndefined();
  expect(watch).not.toHaveBeenCalled();
});

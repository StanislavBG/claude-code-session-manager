'use strict';
import { test, expect, beforeAll, afterAll } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let tmpHome, originalHome, queueStore, cwd;

beforeAll(() => {
  originalHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'qs-last-dispatch-'));
  process.env.HOME = tmpHome;
  cwd = path.join(tmpHome, 'project');
  fs.mkdirSync(cwd, { recursive: true });
  queueStore = require('../lib/scheduler/queueStore.cjs');
});
afterAll(() => {
  process.env.HOME = originalHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

const base = () => ({ config: {}, jobs: [] });

test('round trips lastDispatchAtByCwd (async and sync reads)', async () => {
  const map = { [cwd]: '2026-11-01T00:00:00.000Z' };
  await queueStore.writeSplit({ ...base(), lastDispatchAtByCwd: map }, cwd);
  expect((await queueStore.readMerged({ cwd })).lastDispatchAtByCwd).toEqual(map);
  expect(queueStore.readMergedSync({ cwd }).lastDispatchAtByCwd).toEqual(map);
});

test('defaults to {} when absent', async () => {
  await queueStore.writeSplit(base(), cwd);
  expect((await queueStore.readMerged({ cwd })).lastDispatchAtByCwd).toEqual({});
  expect(queueStore.readMergedSync({ cwd }).lastDispatchAtByCwd).toEqual({});
});

test('non-object values read back as {}', async () => {
  for (const bad of ['x', 5, ['a'], null, true]) {
    await queueStore.writeSplit({ ...base(), lastDispatchAtByCwd: bad }, cwd);
    expect((await queueStore.readMerged({ cwd })).lastDispatchAtByCwd).toEqual({});
    expect(queueStore.readMergedSync({ cwd }).lastDispatchAtByCwd).toEqual({});
  }
});

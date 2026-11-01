/**
 * scheduler-memory-gate-swap.test.cjs — the memory gate also reads swap and
 * limits dispatch to one running job when swap is nearly exhausted.
 *
 * Run: timeout 200 npx vitest run src/main/__tests__/scheduler-memory-gate-swap.test.cjs
 */

'use strict';

import { test, expect, vi, afterEach } from 'vitest';
const fs = require('node:fs');
const scheduler = require('../scheduler.cjs');

afterEach(() => vi.restoreAllMocks());

const RAW = [
  'MemTotal:       16000000 kB',
  'MemAvailable:    4194304 kB',
  'SwapTotal:      8388608 kB',
  'SwapFree:             0 kB',
  '',
].join('\n');

test('parseMemInfo returns MB figures', () => {
  expect(scheduler.parseMemInfo(RAW)).toEqual({ availableMb: 4096, swapTotalMb: 8192, swapFreeMb: 0 });
});

test('readMemInfo reads the SM_MEMINFO_PATH fixture when set', () => {
  const os = require('node:os');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-meminfo-'));
  const file = path.join(dir, 'meminfo');
  fs.writeFileSync(file, RAW);
  const prev = process.env.SM_MEMINFO_PATH;
  process.env.SM_MEMINFO_PATH = file;
  try {
    expect(scheduler.readMemInfo()).toEqual({ availableMb: 4096, swapTotalMb: 8192, swapFreeMb: 0 });
  } finally {
    if (prev === undefined) delete process.env.SM_MEMINFO_PATH;
    else process.env.SM_MEMINFO_PATH = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('parseMemInfo with no swap lines reports zero swap; no MemAvailable fails open', () => {
  expect(scheduler.parseMemInfo('MemAvailable: 2048 kB\n')).toEqual({ availableMb: 2, swapTotalMb: 0, swapFreeMb: 0 });
  expect(scheduler.parseMemInfo('garbage').availableMb).toBe(Infinity);
});

test('clamp at 0, 1 and 2 running jobs when swap is nearly exhausted', () => {
  const mem = { swapTotalMb: 8192, swapFreeMb: 500 };
  expect(scheduler.swapLimitedBatchSize(mem, 0, 3)).toBe(1);
  expect(scheduler.swapLimitedBatchSize(mem, 1, 3)).toBe(0);
  expect(scheduler.swapLimitedBatchSize(mem, 2, 3)).toBe(0);
  expect(scheduler.swapLimitedBatchSize(mem, 0, 0)).toBe(0);
});

test('swap at or above 10 percent free does not clamp', () => {
  const mem = { swapTotalMb: 1000, swapFreeMb: 100 };
  expect(scheduler.swapLimitedBatchSize(mem, 3, 4)).toBe(4);
});

test('no swap configured: clamp does nothing', () => {
  expect(scheduler.swapLimitedBatchSize({ swapTotalMb: 0, swapFreeMb: 0 }, 3, 4)).toBe(4);
});

test('fail-open: getAvailableMemMb returns Infinity on read error', () => {
  vi.spyOn(fs, 'readFileSync').mockImplementation(() => { throw new Error('EACCES'); });
  expect(scheduler.getAvailableMemMb()).toBe(Infinity);
  expect(scheduler.readMemInfo().swapTotalMb).toBe(0);
});

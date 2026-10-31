/**
 * scheduler-oom-bias.test.cjs — job oom_score_adj bias is 200 and best-effort.
 *
 * Run: timeout 200 npx vitest run src/main/__tests__/scheduler-oom-bias.test.cjs
 */

'use strict';

import { test, expect, vi, afterEach } from 'vitest';
const fs = require('node:fs');
const scheduler = require('../scheduler.cjs');

afterEach(() => vi.restoreAllMocks());

test('bias constant is 200', () => {
  expect(scheduler.OOM_SCORE_ADJ_JOB).toBe(200);
});

test('biasJobOomScore writes 200 to the pid oom_score_adj path', () => {
  const spy = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {});
  scheduler.biasJobOomScore(4242);
  if (process.platform === 'linux') {
    expect(spy).toHaveBeenCalledWith('/proc/4242/oom_score_adj', '200');
  } else {
    expect(spy).not.toHaveBeenCalled();
  }
});

test('biasJobOomScore swallows write errors', () => {
  vi.spyOn(fs, 'writeFileSync').mockImplementation(() => { throw new Error('ENOENT'); });
  expect(() => scheduler.biasJobOomScore(4242)).not.toThrow();
});

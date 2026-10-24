/**
 * createPrdEstimateOptional.test.cjs — pins the whole "estimateMinutes is optional"
 * contract for scheduler_create_prd: zod schema, written body, kill budget.
 *
 * Run: timeout 300 npx vitest run src/main/__tests__/createPrdEstimateOptional.test.cjs
 */

'use strict';

import { test, expect } from 'vitest';
const { schemas } = require('../ipcSchemas.cjs');
const { buildPrdBody } = require('../lib/prd/prdCreate.cjs');

const basePrd = {
  title: 'omit the estimate',
  goal: 'Create a PRD without estimateMinutes',
  acceptanceCriteria: ['it is accepted'],
  implementationNotes: 'n/a',
};

test('schema accepts a payload with no estimateMinutes', () => {
  const parsed = schemas.schedulerCreatePrd.safeParse(basePrd);
  expect(parsed.success).toBe(true);
  expect(parsed.data.estimateMinutes).toBeUndefined();
});

test('schema still validates estimateMinutes when supplied', () => {
  expect(schemas.schedulerCreatePrd.safeParse({ ...basePrd, estimateMinutes: 0 }).success).toBe(false);
  expect(schemas.schedulerCreatePrd.safeParse({ ...basePrd, estimateMinutes: 2.5 }).success).toBe(false);
  expect(schemas.schedulerCreatePrd.safeParse({ ...basePrd, estimateMinutes: 20 }).success).toBe(true);
});

test('buildPrdBody writes no estimateMinutes line when omitted', () => {
  const parsed = schemas.schedulerCreatePrd.safeParse(basePrd);
  expect(parsed.success).toBe(true);
  const body = buildPrdBody({ ...parsed.data, cwd: '/tmp/x' });
  expect(body).not.toMatch(/^estimateMinutes:/m);
});

test('computeJobBudgetMs(undefined) is the 45-minute floor', () => {
  const keys = ['SM_JOB_BUDGET_FLOOR_MINUTES', 'SM_JOB_BUDGET_FACTOR'];
  const saved = {};
  for (const k of keys) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  try {
    const { computeJobBudgetMs } = require('../scheduler/budget.cjs');
    expect(computeJobBudgetMs(undefined)).toBe(45 * 60_000);
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
});

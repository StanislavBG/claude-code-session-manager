/**
 * ipcSchemas-dependsOn.test.cjs — dependsOn array cap for schedulerCreatePrd
 * (PRD: raise-dependson-cap-to-100). A /develop plan's validate PRD depends
 * on every other slug in the plan, so the cap must clear a 36-PRD plan while
 * still bounding an unbounded payload.
 *
 * Run: timeout 300 npx vitest run src/main/__tests__/ipcSchemas-dependsOn.test.cjs
 */

'use strict';

import { test, expect } from 'vitest';
const { schemas } = require('../ipcSchemas.cjs');

const basePrd = {
  title: 'validate the plan',
  estimateMinutes: 5,
  goal: 'Validate the plan',
  acceptanceCriteria: ['it validates'],
  implementationNotes: 'n/a',
};

test('schedulerCreatePrd accepts 36 dependsOn entries', () => {
  const dependsOn = Array.from({ length: 36 }, (_, i) => `prd-${i}`);
  const result = schemas.schedulerCreatePrd.safeParse({ ...basePrd, dependsOn });
  expect(result.success).toBe(true);
});

test('schedulerCreatePrd rejects 101 dependsOn entries', () => {
  const dependsOn = Array.from({ length: 101 }, (_, i) => `prd-${i}`);
  const result = schemas.schedulerCreatePrd.safeParse({ ...basePrd, dependsOn });
  expect(result.success).toBe(false);
});

test('schedulerCreatePrd accepts exactly 100 dependsOn entries', () => {
  const dependsOn = Array.from({ length: 100 }, (_, i) => `prd-${i}`);
  const result = schemas.schedulerCreatePrd.safeParse({ ...basePrd, dependsOn });
  expect(result.success).toBe(true);
});

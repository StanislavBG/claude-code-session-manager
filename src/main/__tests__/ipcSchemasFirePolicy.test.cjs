/**
 * ipcSchemasFirePolicy.test.cjs — the legacy `on-reset` fire policy is no
 * longer accepted at the IPC input boundary.
 *
 * Run: timeout 300 npx vitest run src/main/__tests__/ipcSchemasFirePolicy.test.cjs
 */

'use strict';

import { test, expect } from 'vitest';
const { schemas } = require('../ipcSchemas.cjs');

test('setConfigSchema rejects firePolicy on-reset', () => {
  expect(schemas.setConfigSchema.safeParse({ firePolicy: 'on-reset' }).success).toBe(false);
});

test('setConfigSchema accepts when-available, manual and an omitted firePolicy', () => {
  expect(schemas.setConfigSchema.safeParse({ firePolicy: 'when-available' }).success).toBe(true);
  expect(schemas.setConfigSchema.safeParse({ firePolicy: 'manual' }).success).toBe(true);
  expect(schemas.setConfigSchema.safeParse({}).success).toBe(true);
});

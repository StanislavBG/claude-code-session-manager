'use strict';

import { test, expect } from 'vitest';
const { setSessionSlotsSchema } = require('../ipcSchemas.cjs').schemas ?? require('../ipcSchemas.cjs');
const { MAX_SLOTS } = require('../lib/scheduler/sessionSlots.cjs');

test('MAX_SLOTS is 32', () => expect(MAX_SLOTS).toBe(32));
test.each([0, 11, 32])('cap %s parses', (cap) => {
  expect(setSessionSlotsSchema.safeParse({ cap }).success).toBe(true);
});
test.each([33, -1, 2.5])('cap %s rejected', (cap) => {
  expect(setSessionSlotsSchema.safeParse({ cap }).success).toBe(false);
});

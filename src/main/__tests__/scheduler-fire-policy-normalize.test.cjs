/**
 * scheduler-fire-policy-normalize.test.cjs — a persisted legacy fire policy
 * is migrated to 'when-available'; live policies pass through.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/scheduler-fire-policy-normalize.test.cjs
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
import { test, expect } from 'vitest';

process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'fire-policy-norm-'));
const { normalizeConfig } = require('../scheduler.cjs');

test('legacy on-reset becomes when-available, other fields kept', () => {
  const out = normalizeConfig({ firePolicy: 'on-reset', offsetMinutes: 15 });
  expect(out).toEqual({ firePolicy: 'when-available', offsetMinutes: 15 });
});

test('manual and when-available pass through unchanged', () => {
  for (const firePolicy of ['manual', 'when-available']) {
    const cfg = { firePolicy, offsetMinutes: 5 };
    expect(normalizeConfig(cfg)).toEqual({ firePolicy, offsetMinutes: 5 });
  }
});

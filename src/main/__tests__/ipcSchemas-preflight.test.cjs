/**
 * ipcSchemas-preflight.test.cjs — the optional `preflight` string on create,
 * batch-create entries and update-prd frontmatter (PRD preflight-api-schemas).
 *
 * Run: timeout 300 npx vitest run src/main/__tests__/ipcSchemas-preflight.test.cjs
 */

'use strict';

import { describe, test, expect } from 'vitest';
const { schemas } = require('../ipcSchemas.cjs');

const basePrd = {
  title: 'needs a precondition',
  goal: 'Do the thing',
  acceptanceCriteria: ['it is done'],
  implementationNotes: 'n/a',
};
const CMD = 'timeout 30 test -f /tmp/ready';

const cases = {
  create: (preflight) => schemas.schedulerCreatePrd.safeParse({ ...basePrd, preflight }),
  'batch entry': (preflight) => schemas.adminCreatePrds.safeParse({ prds: [{ ...basePrd, preflight }] }),
  update: (preflight) => schemas.adminUpdatePrd.safeParse({ slug: '12-some-prd', frontmatter: { preflight } }),
};
const kept = {
  create: (r) => r.data.preflight,
  'batch entry': (r) => r.data.prds[0].preflight,
  update: (r) => r.data.frontmatter.preflight,
};

describe.each(Object.keys(cases))('%s schema preflight', (name) => {
  test('accepts a string and keeps it unchanged', () => {
    const r = cases[name](CMD);
    expect(r.success).toBe(true);
    expect(kept[name](r)).toBe(CMD);
  });
  test('accepts exactly 500 chars, rejects 501', () => {
    expect(cases[name]('x'.repeat(500)).success).toBe(true);
    expect(cases[name]('x'.repeat(501)).success).toBe(false);
  });
  test('rejects a non-string', () => {
    expect(cases[name](42).success).toBe(false);
    expect(cases[name](['timeout 5 true']).success).toBe(false);
  });
});

test('create without preflight leaves it absent', () => {
  const r = schemas.schedulerCreatePrd.safeParse(basePrd);
  expect(r.success).toBe(true);
  expect('preflight' in r.data).toBe(false);
});

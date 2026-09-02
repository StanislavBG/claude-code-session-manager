/**
 * scheduler-leftover-fields.test.cjs — leftoverFieldsFrom/applyLeftoverFields,
 * the pure helpers that turn a newly-dirty path list into the
 * `leftoverPaths`/`leftoverCount`/`leftoverPathsTruncated` triple stamped on
 * a terminal job row (see the leftover-attribution PRD: a `failed` row that
 * left uncommitted work must be visually distinct from one that left
 * nothing).
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/scheduler-leftover-fields.test.cjs
 */

'use strict';

import { test, expect } from 'vitest';
const { leftoverFieldsFrom, applyLeftoverFields, LEFTOVER_PATHS_CAP } = require('../scheduler.cjs');

test('leftoverFieldsFrom: null when the path list is null (git status unavailable) — never treated as "left nothing"', () => {
  expect(leftoverFieldsFrom(null)).toBeNull();
});

test('leftoverFieldsFrom: null for an empty array (left nothing)', () => {
  expect(leftoverFieldsFrom([])).toBeNull();
});

test('leftoverFieldsFrom: a real list returns leftoverPaths + leftoverCount, no truncation flag under the cap', () => {
  const fields = leftoverFieldsFrom(['a.js', 'b.js', 'c.js']);
  expect(fields).toEqual({ leftoverPaths: ['a.js', 'b.js', 'c.js'], leftoverCount: 3 });
});

test('leftoverFieldsFrom: caps the displayed path list at LEFTOVER_PATHS_CAP but keeps the true total count', () => {
  const many = Array.from({ length: LEFTOVER_PATHS_CAP + 12 }, (_, i) => `file-${i}.txt`);
  const fields = leftoverFieldsFrom(many);
  expect(fields.leftoverPaths).toHaveLength(LEFTOVER_PATHS_CAP);
  expect(fields.leftoverCount).toBe(LEFTOVER_PATHS_CAP + 12);
  expect(fields.leftoverPathsTruncated).toBe(true);
});

test('applyLeftoverFields: stamps the fields on the row when paths are present', () => {
  const row = { slug: 'x' };
  applyLeftoverFields(row, ['a.js']);
  expect(row.leftoverPaths).toEqual(['a.js']);
  expect(row.leftoverCount).toBe(1);
  expect(row.leftoverPathsTruncated).toBeUndefined();
});

test('applyLeftoverFields: clears any stale fields from a prior call when the new list is empty/null', () => {
  const row = { slug: 'x', leftoverPaths: ['stale.js'], leftoverCount: 1, leftoverPathsTruncated: true };
  applyLeftoverFields(row, []);
  expect(row.leftoverPaths).toBeUndefined();
  expect(row.leftoverCount).toBeUndefined();
  expect(row.leftoverPathsTruncated).toBeUndefined();
});

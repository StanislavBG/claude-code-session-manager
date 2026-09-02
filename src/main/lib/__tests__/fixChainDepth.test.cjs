/**
 * fixChainDepth.test.cjs — unit tests for the pure fix-chain depth counter
 * (PRD 1113). Run: timeout 120 npx vitest run src/main/lib/__tests__/fixChainDepth.test.cjs
 */

'use strict';

import { test, expect } from 'vitest';
const { fixChainDepthOf, baseSlugOf } = require('../fixChainDepth.cjs');

test('fixChainDepthOf counts consecutive -fix- segments after the leading NN- prefix', () => {
  const cases = [
    // [slug, expected depth]
    ['113-foo', 0],
    ['113-fix-foo', 1],
    ['113-fix-fix-foo', 2],
    ['113-fix-fix-fix-foo', 3],
    // false-positive bait: a later segment merely reading 'fix' does not
    // extend the run once a non-'fix' segment has broken it.
    ['113-fix-loop-extraction-and-round-trip', 1],
    ['22-fix-loop-galaxy-round-trip', 1],
    // false-positive bait: a segment that only contains 'fix' as a substring
    // (not an exact 'fix' segment) is never counted at all.
    ['113-prefix-foo', 0],
    ['113-prefix-fix-foo', 0],
    // no fix chain, multi-digit NN, single-segment slug.
    ['1-widget', 0],
  ];
  for (const [slug, expected] of cases) {
    expect(fixChainDepthOf(slug)).toBe(expected);
  }
});

test('baseSlugOf strips the leading fix chain, keeping the NN prefix', () => {
  expect(baseSlugOf('113-foo')).toBe('113-foo');
  expect(baseSlugOf('113-fix-foo')).toBe('113-foo');
  expect(baseSlugOf('113-fix-fix-foo')).toBe('113-foo');
  expect(baseSlugOf('113-fix-fix-fix-foo')).toBe('113-foo');
  expect(baseSlugOf('113-fix-loop-extraction-and-round-trip')).toBe('113-loop-extraction-and-round-trip');
});

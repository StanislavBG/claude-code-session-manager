/**
 * baselineGateWiring.test.cjs — selector + ledger wiring for baseline gate authority.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/baselineGateWiring.test.cjs
 */
'use strict';

import { test, expect } from 'vitest';
const { selectGateShadowTarget } = require('../scheduler/reviewLadder.cjs');
const { classifyLadderRung } = require('../lib/scheduler/needsReviewLedger.cjs');

const row = (over) => ({
  slug: 's', cwd: '/p', status: 'needs_review', verifierVerdict: 'sentinel_fail',
  landedCommit: 'abc123', guardHeadBefore: 'base111', ...over,
});
const heads = new Map([['/p', 'head999']]);

test('selector picks an eligible sentinel_fail row', () => {
  const j = row();
  expect(selectGateShadowTarget([j], heads, { baselineDisabled: false })).toBe(j);
});

test('selector ignores a sentinel_fail row without guardHeadBefore (stale shadow present)', () => {
  const j = row({ guardHeadBefore: undefined, gateShadow: { head: 'old', definitive: true } });
  expect(selectGateShadowTarget([j], heads, { baselineDisabled: false })).toBeNull();
});

test('selector ignores the row when the kill switch option is set', () => {
  const j = row({ gateShadow: { head: 'old', definitive: true } });
  expect(selectGateShadowTarget([j], heads, { baselineDisabled: true })).toBeNull();
});

test('ledger classifies gateAuthority:baseline as reverify', () => {
  expect(classifyLadderRung({ source: 'gateAuthority:baseline' })).toBe('reverify');
});

/**
 * preflightHoldNotice.test.cjs — unit tests for reviewNotice.cjs's
 * buildPreflightHoldNotice + preflightHoldNoticeKey: the one informational
 * notice an Epic gets when a PRD is held on a failing preflight.
 *
 * Run: timeout 120 npx vitest run src/main/lib/scheduler/__tests__/preflightHoldNotice.test.cjs
 */

'use strict';

import { test, expect } from 'vitest';
const { buildPreflightHoldNotice, preflightHoldNoticeKey } = require('../reviewNotice.cjs');

const base = {
  slug: '12-deploy-relay',
  failText: 'RENDER_API_KEY is not set',
  preflight: 'test -n "$RENDER_API_KEY"',
  heldSlugs: ['12-deploy-relay', '13-smoke-relay'],
  nextAt: '2026-11-22T18:30:00.000Z',
};

test('full text names what is missing, the command, what it holds, when and how it resumes', () => {
  const text = buildPreflightHoldNotice(base);
  expect(text.startsWith('PRECONDITION HOLD')).toBe(true);
  expect(text).toContain('12-deploy-relay');
  expect(text).toContain('"RENDER_API_KEY is not set"');
  expect(text).toContain('test -n "$RENDER_API_KEY"');
  expect(text).toContain('Held: 12-deploy-relay, 13-smoke-relay');
  expect(text).toContain('2026-11-22T18:30:00.000Z');
  expect(text).toMatch(/re-checks on its own/);
  expect(text).toMatch(/exits 0/);
  expect(text).toMatch(/resumes the chain/);
  expect(text).toContain('Reset on 12-deploy-relay re-checks at once');
});

test('failText is quoted verbatim, multi-line included', () => {
  const failText = 'missing:  socat\n  install it first';
  const text = buildPreflightHoldNotice({ ...base, failText });
  expect(text).toContain(failText);
});

test('empty failText says the preflight exited non-zero', () => {
  for (const failText of ['', '   ', undefined, null]) {
    const text = buildPreflightHoldNotice({ ...base, failText });
    expect(text).toMatch(/exited non-zero/);
    expect(text).not.toContain('""');
  }
});

test('empty heldSlugs still names the held slug itself', () => {
  for (const heldSlugs of [[], undefined]) {
    const text = buildPreflightHoldNotice({ ...base, heldSlugs });
    expect(text).toContain('Held: 12-deploy-relay');
  }
});

test('text never asks a question and carries no SM_NEEDS_INPUT marker', () => {
  const variants = [
    base,
    { ...base, failText: '' },
    { ...base, heldSlugs: [] },
    { ...base, nextAt: null },
    {},
  ];
  for (const v of variants) {
    const text = buildPreflightHoldNotice(v);
    expect(text).not.toContain('?');
    expect(text).not.toContain('SM_NEEDS_INPUT');
  }
});

test('preflightHoldNoticeKey is stable per hold and differs across holds', () => {
  const since = '2026-11-22T18:00:00.000Z';
  const a = preflightHoldNoticeKey('12-deploy-relay', since);
  expect(preflightHoldNoticeKey('12-deploy-relay', since)).toBe(a);
  expect(typeof a).toBe('string');
  expect(preflightHoldNoticeKey('12-deploy-relay', '2026-11-22T19:00:00.000Z')).not.toBe(a);
  expect(preflightHoldNoticeKey('13-smoke-relay', since)).not.toBe(a);
});

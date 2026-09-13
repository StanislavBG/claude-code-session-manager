/**
 * prdDisposition.test.cjs — pure logic behind the scheduler wave-disposition
 * PRD: does a new PRD wave extend an Epic's existing dependsOn chain
 * ('append', gaining a dependsOn on the chain's current terminal PRD(s)) or
 * start an independent, parallel-eligible root ('new-head')? And, after the
 * fact, can a human safely rewrite that choice from the Scheduler UI?
 *
 * Run: timeout 120 npx vitest run src/main/lib/__tests__/prdDisposition.test.cjs
 */

'use strict';

import { test, expect } from 'vitest';

const {
  isIncomplete,
  resolveChainTerminals,
  wouldCreateCycle,
  computeDispositionRewrite,
} = require('../prdDisposition.cjs');

function row(overrides) {
  return { slug: 'x', status: 'pending', dependsOn: [], ...overrides };
}

// ─────────────────────────────────────────── isIncomplete

test('isIncomplete: completed is the only complete status', () => {
  expect(isIncomplete('completed')).toBe(false);
  for (const status of [null, undefined, 'pending', 'running', 'needs_review', 'failed', 'quarantined']) {
    expect(isIncomplete(status)).toBe(true);
  }
});

// ─────────────────────────────────────────── resolveChainTerminals

test('resolveChainTerminals: a lone root is its own terminal', () => {
  const rows = [row({ slug: 'a' })];
  expect(resolveChainTerminals(rows)).toEqual(['a']);
});

test('resolveChainTerminals: a linear chain terminates at its tail', () => {
  const rows = [
    row({ slug: 'a' }),
    row({ slug: 'b', dependsOn: ['a'] }),
    row({ slug: 'c', dependsOn: ['b'] }),
  ];
  expect(resolveChainTerminals(rows)).toEqual(['c']);
});

test('resolveChainTerminals: a fork yields both leaves', () => {
  const rows = [
    row({ slug: 'a' }),
    row({ slug: 'b', dependsOn: ['a'] }),
    row({ slug: 'c', dependsOn: ['a'] }),
  ];
  expect(resolveChainTerminals(rows).sort()).toEqual(['b', 'c']);
});

test('resolveChainTerminals: two independent roots are both terminals (existing multi-head Epic)', () => {
  const rows = [row({ slug: 'a' }), row({ slug: 'z' })];
  expect(resolveChainTerminals(rows).sort()).toEqual(['a', 'z']);
});

test('resolveChainTerminals: a dependsOn cycle contributes no terminal', () => {
  const rows = [
    row({ slug: 'a', dependsOn: ['b'] }),
    row({ slug: 'b', dependsOn: ['a'] }),
  ];
  expect(resolveChainTerminals(rows)).toEqual([]);
});

test('resolveChainTerminals: empty input yields no terminals', () => {
  expect(resolveChainTerminals([])).toEqual([]);
});

// ─────────────────────────────────────────── wouldCreateCycle

test('wouldCreateCycle: false for a fresh, unrelated edge', () => {
  const rows = [row({ slug: 'a' }), row({ slug: 'b' })];
  expect(wouldCreateCycle(rows, 'b', ['a'])).toBe(false);
});

test('wouldCreateCycle: true when the target already (transitively) depends on the source', () => {
  // a depends on b; proposing b depends on a closes the loop.
  const rows = [
    row({ slug: 'a', dependsOn: ['b'] }),
    row({ slug: 'b' }),
  ];
  expect(wouldCreateCycle(rows, 'b', ['a'])).toBe(true);
});

test('wouldCreateCycle: true for a direct self-reference', () => {
  const rows = [row({ slug: 'a' })];
  expect(wouldCreateCycle(rows, 'a', ['a'])).toBe(true);
});

test('wouldCreateCycle: false through an unrelated third row', () => {
  const rows = [
    row({ slug: 'a' }),
    row({ slug: 'b', dependsOn: ['a'] }),
    row({ slug: 'c' }),
  ];
  expect(wouldCreateCycle(rows, 'c', ['b'])).toBe(false);
});

// ─────────────────────────────────────────── computeDispositionRewrite

test('append sets the expected edges', () => {
  const rows = [
    row({ slug: 'wave1-tail' }),
    row({ slug: 'wave2-root' }),
  ];
  const result = computeDispositionRewrite({
    slug: 'wave2-root',
    disposition: 'append',
    dependsOn: ['wave1-tail'],
    rows,
  });
  expect(result).toEqual({ ok: true, dependsOn: ['wave1-tail'] });
});

test('new-head sets none', () => {
  const rows = [
    row({ slug: 'wave1-tail' }),
    row({ slug: 'wave2-root', dependsOn: ['wave1-tail'] }),
  ];
  const result = computeDispositionRewrite({
    slug: 'wave2-root',
    disposition: 'new-head',
    dependsOn: [],
    rows,
  });
  expect(result).toEqual({ ok: true, dependsOn: [] });
});

test('promoting a wave to a head removes exactly its root edges', () => {
  const rows = [
    row({ slug: 'wave1-tail' }),
    row({ slug: 'other-head' }),
    row({ slug: 'wave2-root', dependsOn: ['wave1-tail'] }),
  ];
  const result = computeDispositionRewrite({
    slug: 'wave2-root',
    disposition: 'new-head',
    dependsOn: [],
    rows,
  });
  expect(result.ok).toBe(true);
  expect(result.dependsOn).toEqual([]);
  // The unrelated head's own row is untouched — this function only ever
  // returns the target row's new dependsOn, never mutates `rows`.
  expect(rows.find((r) => r.slug === 'other-head').dependsOn).toEqual([]);
});

test('a change that would create a cycle is rejected', () => {
  const rows = [
    row({ slug: 'a', dependsOn: ['b'] }),
    row({ slug: 'b' }),
  ];
  const result = computeDispositionRewrite({
    slug: 'b',
    disposition: 'append',
    dependsOn: ['a'],
    rows,
  });
  expect(result.ok).toBe(false);
  expect(result.error).toMatch(/cycle/i);
});

test('running rows are untouched', () => {
  const rows = [
    row({ slug: 'wave1-tail' }),
    row({ slug: 'wave2-root', status: 'running', dependsOn: ['wave1-tail'] }),
  ];
  const result = computeDispositionRewrite({
    slug: 'wave2-root',
    disposition: 'new-head',
    dependsOn: [],
    rows,
  });
  expect(result.ok).toBe(false);
  expect(result.error).toMatch(/running/i);
});

test('completed rows are untouched', () => {
  const rows = [
    row({ slug: 'wave1-tail' }),
    row({ slug: 'wave2-root', status: 'completed', dependsOn: ['wave1-tail'] }),
  ];
  const result = computeDispositionRewrite({
    slug: 'wave2-root',
    disposition: 'append',
    dependsOn: ['wave1-tail'],
    rows,
  });
  expect(result.ok).toBe(false);
  expect(result.error).toMatch(/completed/i);
});

test('refuses to rewrite a row whose existing blocker has already completed', () => {
  const rows = [
    row({ slug: 'blocker', status: 'completed' }),
    row({ slug: 'dependent', status: 'pending', dependsOn: ['blocker'] }),
  ];
  const result = computeDispositionRewrite({
    slug: 'dependent',
    disposition: 'new-head',
    dependsOn: [],
    rows,
  });
  expect(result.ok).toBe(false);
  expect(result.error).toMatch(/already completed|satisfied/i);
});

test('unknown slug is refused, not silently ignored', () => {
  const result = computeDispositionRewrite({
    slug: 'ghost',
    disposition: 'new-head',
    dependsOn: [],
    rows: [row({ slug: 'a' })],
  });
  expect(result.ok).toBe(false);
});

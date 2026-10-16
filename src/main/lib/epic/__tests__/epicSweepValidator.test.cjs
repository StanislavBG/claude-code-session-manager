/**
 * epicSweepValidator.test.cjs — pure sweep-validator PRD input builder.
 *
 * Run: timeout 120 npx vitest run src/main/lib/epic/__tests__/epicSweepValidator.test.cjs
 */

'use strict';

import { test, expect } from 'vitest';
const {
  SWEEP_SLUG_PREFIX,
  MAX_SWEEP_PRDS,
  isSweepValidatorSlug,
  buildSweepValidatorInput,
} = require('../epicSweepValidator.cjs');

const NOW = Date.UTC(2026, 9, 16, 3, 10, 45);
const entries = (n) => Array.from({ length: n }, (_, i) => ({ slug: `${100 + i}-prd-${i}`, bareSlug: `prd-${i}` }));
const build = (uncovered, baseSha = 'abc123') =>
  buildSweepValidatorInput({ epicId: 'epic-1', cwd: '/proj', uncovered, baseSha, now: NOW });

test('constants', () => {
  expect(SWEEP_SLUG_PREFIX).toBe('validate-sweep');
  expect(MAX_SWEEP_PRDS).toBe(25);
});

test('isSweepValidatorSlug', () => {
  expect(isSweepValidatorSlug('validate-sweep-202610160310')).toBe(true);
  expect(isSweepValidatorSlug('2001-validate-sweep-202610160310')).toBe(true);
  expect(isSweepValidatorSlug('validate-campaign-spine')).toBe(false);
  expect(isSweepValidatorSlug(undefined)).toBe(false);
  expect(isSweepValidatorSlug(42)).toBe(false);
});

test('builds the input shape', () => {
  const { input, carried } = build(entries(2));
  expect(carried).toEqual([]);
  expect(input).toMatchObject({
    agentType: 'validator',
    tag: 'build',
    estimateMinutes: 10,
    gate: ['none'],
    sourcePromptId: 'epic-1',
    cwd: '/proj',
    slug: 'validate-sweep-202610160310',
    dependsOn: ['prd-0', 'prd-1'],
    files: ['session-manager-operations/reviews/validation/epic-1/validate-sweep-202610160310.md'],
  });
  expect(input.slug.length).toBeLessThanOrEqual(60);
  expect(input.title.startsWith('Validate: ')).toBe(true);
  expect(input.acceptanceCriteria).toHaveLength(3);
  expect(input.acceptanceCriteria[0]).toContain('prd-0');
  expect(input.acceptanceCriteria[0]).toContain('epics/epic-1/prds/');
  expect(input.acceptanceCriteria[2]).toContain('Record written and committed at');
  expect(input.implementationNotes).toContain('Work as the validator persona — the procedure is your system prompt.');
  expect(input.implementationNotes).toContain('Base: abc123');
});

test('derives bare slugs when bareSlug is absent', () => {
  const { input } = build([{ slug: '12-foo' }]);
  expect(input.dependsOn).toEqual(['foo']);
});

test('caps at MAX_SWEEP_PRDS and carries the overflow', () => {
  const all = entries(MAX_SWEEP_PRDS + 3);
  const { input, carried } = build(all);
  expect(input.dependsOn).toHaveLength(MAX_SWEEP_PRDS);
  expect(input.acceptanceCriteria).toHaveLength(MAX_SWEEP_PRDS + 1);
  expect(carried).toEqual(all.slice(MAX_SWEEP_PRDS));
});

test('null baseSha says Base: unknown and points at landed commits', () => {
  const { input } = build(entries(1), null);
  expect(input.implementationNotes).toContain('Base: unknown');
  expect(input.implementationNotes).toContain('landed commit');
});

test('empty or invalid uncovered yields no input', () => {
  expect(build([])).toEqual({ input: null, carried: [] });
  expect(build(undefined)).toEqual({ input: null, carried: [] });
});

test('no text carries a gate fence or Gate/Files heading', () => {
  const { input } = build(entries(3), null);
  const text = JSON.stringify(input);
  expect(text).not.toContain('```gate');
  expect(text).not.toMatch(/# Gate/);
  expect(text).not.toMatch(/# Files/);
});

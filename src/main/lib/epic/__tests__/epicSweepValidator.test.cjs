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
  validatorEstimateMinutes,
  VALIDATOR_OVERHEAD_MS,
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
  expect(isSweepValidatorSlug('2001-validate-sweep-20261016031045')).toBe(true);
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
    slug: 'validate-sweep-20261016031045',
    dependsOn: ['prd-0', 'prd-1'],
    files: ['session-manager-operations/reviews/validation/epic-1/validate-sweep-20261016031045.md'],
  });
  expect(input.slug.length).toBeLessThanOrEqual(60);
  expect(input.title.startsWith('Validate: ')).toBe(true);
  expect(input.acceptanceCriteria).toHaveLength(3);
  expect(input.acceptanceCriteria[0]).toContain('prd-0');
  expect(input.acceptanceCriteria[0]).toContain('epics/epic-1/prds/');
  expect(input.acceptanceCriteria[2]).toContain('Record written and committed at');
  expect(input.acceptanceCriteria[2]).toContain('git rev-parse --show-toplevel');
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

const MIN = 60_000;
const { computeJobBudgetMs } = require('../../../scheduler/budget.cjs');
const { buildPrdBody } = require('../../prd/prdCreate.cjs');
const withGate = (n, ms) => entries(n).map((e) => ({ ...e, gateMs: ms }));

test('validatorEstimateMinutes: floor, unknown, zero, factor', () => {
  expect(VALIDATOR_OVERHEAD_MS).toBe(15 * MIN);
  expect(validatorEstimateMinutes([], { factor: 3 })).toBe(10);
  expect(validatorEstimateMinutes([undefined, NaN, -1, 'x'], { factor: 3 })).toBe(12);
  expect(validatorEstimateMinutes([0, 0], { factor: 1 })).toBe(15);
  expect(validatorEstimateMinutes([30 * MIN], { factor: 0 })).toBe(15);
  expect(validatorEstimateMinutes([60 * MIN], { factor: 2 })).toBe(38);
});

test('short gates keep the 45 minute floor; 92.5 minutes of gates is covered', () => {
  const { input } = build(withGate(3, 10 * MIN));
  expect(computeJobBudgetMs(input.estimateMinutes)).toBe(45 * MIN);
  const big = build(withGate(1, 92.5 * MIN)).input;
  expect(computeJobBudgetMs(big.estimateMinutes)).toBeGreaterThanOrEqual(107.5 * MIN);
});

test('first-fit split at the ceiling', () => {
  const jobBudget = { factor: 3, ceilingMs: 60 * MIN };
  const at = buildSweepValidatorInput({ epicId: 'e', cwd: '/p', uncovered: [{ slug: '1-a', gateMs: 20 * MIN }, { slug: '2-b', gateMs: 25 * MIN }], now: NOW, jobBudget });
  expect(at.carried).toEqual([]);
  expect(at.input.budgetExempt).toBeUndefined();
  const over = buildSweepValidatorInput({ epicId: 'e', cwd: '/p', uncovered: [{ slug: '1-a', gateMs: 20 * MIN }, { slug: '2-b', gateMs: 25 * MIN + 1 }], now: NOW, jobBudget });
  expect(over.input.dependsOn).toEqual(['a']);
  expect(over.carried).toHaveLength(1);
});

test('draining carried covers every PRD once, each budget covers its work', () => {
  const jobBudget = { factor: 3, ceilingMs: 60 * MIN };
  let rest = [10, 30, 30, 5, 40, 20, 20].map((m, i) => ({ slug: `${i}-p${i}`, gateMs: m * MIN }));
  const seen = [];
  while (rest.length) {
    const { input, carried } = buildSweepValidatorInput({ epicId: 'e', cwd: '/p', uncovered: rest, now: NOW, jobBudget });
    seen.push(...input.dependsOn);
    expect(computeJobBudgetMs(input.estimateMinutes, jobBudget)).toBeGreaterThanOrEqual(
      Math.min(60 * MIN, 15 * MIN + rest.slice(0, input.dependsOn.length).reduce((a, e) => a + e.gateMs, 0)));
    rest = carried;
  }
  expect([...seen].sort()).toEqual([0, 1, 2, 3, 4, 5, 6].map((i) => `p${i}`));
});

test('single oversize PRD is budget-exempt, carrying the others', () => {
  const { input, carried } = buildSweepValidatorInput({ epicId: 'e', cwd: '/p', uncovered: [{ slug: '1-a', gateMs: 90 * MIN }, { slug: '2-b', gateMs: MIN }], now: NOW, jobBudget: { factor: 2, ceilingMs: 60 * MIN } });
  expect(input.budgetExempt).toBe(true);
  expect(carried).toHaveLength(1);
});

test('MAX_SWEEP_PRDS still caps', () => {
  const { input, carried } = build(withGate(MAX_SWEEP_PRDS + 2, 0));
  expect(input.dependsOn).toHaveLength(MAX_SWEEP_PRDS);
  expect(carried).toHaveLength(2);
});

test('buildPrdBody writes budgetExempt only for a sweep validator', () => {
  const base = { title: 't', cwd: '/p', goal: 'g', acceptanceCriteria: ['a'], budgetExempt: true };
  const sweep = buildPrdBody({ ...base, slug: 'validate-sweep-20261016031045', agentType: 'validator' });
  expect(sweep).toContain('budgetExempt: true');
  expect(buildPrdBody({ ...base, slug: 'validate-sweep-1', agentType: 'dev-lead' })).not.toContain('budgetExempt');
  expect(buildPrdBody({ ...base, slug: 'other', agentType: 'validator' })).not.toContain('budgetExempt');
});

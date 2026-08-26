/**
 * health-claude-md-budget.test.cjs — CLAUDE.md SIZE BUDGET enforcement
 * (PRD 1039, following CLAUDE.md's growth from 3,871 to 65,768 chars between
 * 2026-05-09 and 2026-08-13 with zero of 359 PRDs ever pruning it). Exercises
 * parseClaudeMdBudget()/evaluateClaudeMdBudget() directly since they're pure —
 * no need to spawn the full check() to cover this.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/health-claude-md-budget.test.cjs
 */

'use strict';

import { test, expect } from 'vitest';
const { parseClaudeMdBudget, evaluateClaudeMdBudget } = require('../health.cjs');

test('under budget reports ok with no issue', () => {
  const result = evaluateClaudeMdBudget(11873, 12000);
  expect(result.ok).toBe(true);
  expect(result.applicable).toBe(true);
  expect(result.message).toBeUndefined();
});

test('exactly at budget reports ok with no issue', () => {
  const result = evaluateClaudeMdBudget(12000, 12000);
  expect(result.ok).toBe(true);
  expect(result.applicable).toBe(true);
});

test('over budget reports one issue with actual size and budget in the message', () => {
  const result = evaluateClaudeMdBudget(13210, 12000);
  expect(result.ok).toBe(false);
  expect(result.overage).toBe(1210);
  expect(result.message).toContain('13210');
  expect(result.message).toContain('12000');
  expect(result.message).toContain('1210');
});

test('no SIZE BUDGET line present -> parses to null, evaluator skips silently', () => {
  const text = '# Some Project\n\nJust a normal CLAUDE.md with no budget declared.\n';
  const budget = parseClaudeMdBudget(text);
  expect(budget).toBeNull();
  const result = evaluateClaudeMdBudget(50000, budget);
  expect(result.ok).toBe(true);
  expect(result.applicable).toBe(false);
});

test('malformed/unparseable budget line -> null, no throw', () => {
  const text = '> **SIZE BUDGET — a lot of chars**, checked before every commit.';
  expect(() => parseClaudeMdBudget(text)).not.toThrow();
  const budget = parseClaudeMdBudget(text);
  expect(budget).toBeNull();
});

test('comma-separated form parses to a plain integer', () => {
  const text = '> **SIZE BUDGET — 12,000 chars**, checked with `wc -c CLAUDE.md` before every commit.';
  expect(parseClaudeMdBudget(text)).toBe(12000);
});

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
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseClaudeMdBudget, evaluateClaudeMdBudget, measureRootClaudeMdPair, evaluateRootClaudeMdBudget } = require('../health.cjs');

function scratch(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-md-pair-'));
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
  return dir;
}

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

test('AGENTS.md + CLAUDE.md pair: budget comes from AGENTS.md and both files count', () => {
  const stub = '@AGENTS.md\n';
  const map = '> **SIZE BUDGET — 100 chars**\n' + 'x'.repeat(40) + '\n';
  const dir = scratch({ 'CLAUDE.md': stub, 'AGENTS.md': map });
  try {
    const m = measureRootClaudeMdPair(dir);
    expect(m.mapName).toBe('AGENTS.md');
    expect(m.budget).toBe(100);
    expect(m.chars).toBe(Buffer.byteLength(stub) + Buffer.byteLength(map));
    expect(evaluateRootClaudeMdBudget(dir).ok).toBe(true);
    // Grow the stub so only the PAIR goes over budget.
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), stub + 'y'.repeat(40));
    const r = evaluateRootClaudeMdBudget(dir);
    expect(r.ok).toBe(false);
    expect(r.message).toContain('CLAUDE.md + AGENTS.md');
    expect(r.message).toContain('AGENTS.md)');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('CLAUDE.md alone: measured and budgeted as before', () => {
  const text = '> **SIZE BUDGET — 50 chars**\n' + 'z'.repeat(40) + '\n';
  const dir = scratch({ 'CLAUDE.md': text });
  try {
    const m = measureRootClaudeMdPair(dir);
    expect(m.mapName).toBe('CLAUDE.md');
    expect(m.chars).toBe(Buffer.byteLength(text));
    const r = evaluateRootClaudeMdBudget(dir);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/^CLAUDE\.md is \d+ chars/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('neither file: not applicable', () => {
  const dir = scratch({});
  try {
    expect(measureRootClaudeMdPair(dir)).toBeNull();
    expect(evaluateRootClaudeMdBudget(dir)).toEqual({ ok: true, applicable: false });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

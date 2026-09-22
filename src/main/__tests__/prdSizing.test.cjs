/**
 * prdSizing.test.cjs — unit tests for sizingWarnings (PRD 1403).
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/prdSizing.test.cjs
 */

'use strict';

import { test, expect } from 'vitest';
const { SIZING_LIMITS, sizingWarnings } = require('../lib/prdSizing.cjs');

function compliantInput(overrides = {}) {
  return {
    estimateMinutes: 10,
    acceptanceCriteria: ['widget frobnicates on click', 'unit test covers the frobnication path'],
    goal: 'Add frobnication to the widget subsystem.',
    implementationNotes: 'See src/widget.cjs:10.',
    ...overrides,
  };
}

test('compliant PRD yields no warnings', () => {
  expect(sizingWarnings(compliantInput())).toEqual([]);
});

test('warns when estimateMinutes exceeds the limit', () => {
  const warnings = sizingWarnings(compliantInput({ estimateMinutes: SIZING_LIMITS.estimateMinutes + 1 }));
  expect(warnings.some((w) => /estimateMinutes/.test(w))).toBe(true);
});

test('does not warn when estimateMinutes is exactly the limit', () => {
  const warnings = sizingWarnings(compliantInput({ estimateMinutes: SIZING_LIMITS.estimateMinutes }));
  expect(warnings.some((w) => /estimateMinutes/.test(w))).toBe(false);
});

test('warns when acceptanceCriteria has more than the limit of lines', () => {
  const acceptanceCriteria = Array.from({ length: SIZING_LIMITS.acLines + 1 }, (_, i) => `criterion ${i}`);
  const warnings = sizingWarnings(compliantInput({ acceptanceCriteria }));
  expect(warnings.some((w) => /acceptanceCriteria has/.test(w))).toBe(true);
});

test('does not warn when acceptanceCriteria has exactly the limit of lines', () => {
  const acceptanceCriteria = Array.from({ length: SIZING_LIMITS.acLines }, (_, i) => `criterion ${i}`);
  const warnings = sizingWarnings(compliantInput({ acceptanceCriteria }));
  expect(warnings.some((w) => /acceptanceCriteria has/.test(w))).toBe(false);
});

test('warns when an AC line exceeds the per-line character limit', () => {
  const longLine = 'x'.repeat(SIZING_LIMITS.acLineChars + 1);
  const warnings = sizingWarnings(compliantInput({ acceptanceCriteria: [longLine] }));
  expect(warnings.some((w) => /exceed \d+ characters/.test(w))).toBe(true);
});

test('does not warn when an AC line is exactly at the per-line character limit', () => {
  const line = 'x'.repeat(SIZING_LIMITS.acLineChars);
  const warnings = sizingWarnings(compliantInput({ acceptanceCriteria: [line] }));
  expect(warnings.some((w) => /exceed \d+ characters/.test(w))).toBe(false);
});

test('warns on an open-ended search-and-fix AC line', () => {
  const warnings = sizingWarnings(compliantInput({
    acceptanceCriteria: ['grep e2e specs and update expectations to match the new sort order'],
  }));
  expect(warnings.some((w) => /open-ended search-and-fix/.test(w))).toBe(true);
});

test('does not warn on an AC line that merely mentions grep or update in isolation', () => {
  const warnings = sizingWarnings(compliantInput({
    acceptanceCriteria: ['grep confirms no leftover references to the old flag'],
  }));
  expect(warnings.some((w) => /open-ended search-and-fix/.test(w))).toBe(false);
});

test('warns on an open-ended search-and-fix AC line whose "then"/"update" half is a second sentence', () => {
  const warnings = sizingWarnings(compliantInput({
    acceptanceCriteria: ['Grep the repo for every usage of the old flag. Then update each call site.'],
  }));
  expect(warnings.some((w) => /open-ended search-and-fix/.test(w))).toBe(true);
});

test('warns on an AC line with two or more timeout commands', () => {
  const warnings = sizingWarnings(compliantInput({
    acceptanceCriteria: ['timeout 120 npm run typecheck && timeout 300 npm run test:unit both pass'],
  }));
  expect(warnings.some((w) => /two or more `timeout/.test(w))).toBe(true);
});

test('does not warn on an AC line with a single timeout command', () => {
  const warnings = sizingWarnings(compliantInput({
    acceptanceCriteria: ['timeout 120 npm run typecheck passes'],
  }));
  expect(warnings.some((w) => /two or more `timeout/.test(w))).toBe(false);
});

test('warns when goal + implementationNotes + joined AC exceeds the body character limit', () => {
  const warnings = sizingWarnings(compliantInput({
    goal: 'g'.repeat(SIZING_LIMITS.bodyChars + 1),
  }));
  expect(warnings.some((w) => /exceeding the \d+-character sizing limit/.test(w))).toBe(true);
});

test('does not warn when the combined body is exactly at the character limit', () => {
  const goal = 'g'.repeat(SIZING_LIMITS.bodyChars);
  const warnings = sizingWarnings({ estimateMinutes: 10, acceptanceCriteria: [], goal, implementationNotes: '' });
  expect(warnings.some((w) => /exceeding the \d+-character sizing limit/.test(w))).toBe(false);
});

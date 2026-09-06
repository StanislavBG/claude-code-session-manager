/**
 * runVerify-blocked-by-foreign-wip.test.cjs — scanSentinel's new
 * BLOCKED_BY_FOREIGN_WIP token and the scanForeignWipPathsClaim evidence-line
 * scanner (the executor-facing half of "give the executor a first-class
 * verdict for a sibling job's in-flight file, but validate the claim").
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/runVerify-blocked-by-foreign-wip.test.cjs
 */

'use strict';

import { test, expect } from 'vitest';
const { scanSentinel, scanForeignWipPathsClaim } = require('../runVerify.cjs');

function resultEventFor(text) {
  return { kind: 'result', seq: 0, subtype: 'success', resultText: text };
}

test('scanSentinel: recognizes BLOCKED_BY_FOREIGN_WIP alongside PASS/FAIL', () => {
  expect(scanSentinel(resultEventFor('SCHEDULER_VERDICT: PASS'), [])).toBe('pass');
  expect(scanSentinel(resultEventFor('SCHEDULER_VERDICT: FAIL bad thing'), [])).toBe('fail');
  expect(scanSentinel(resultEventFor('SCHEDULER_VERDICT: BLOCKED_BY_FOREIGN_WIP'), [])).toBe('blocked_by_foreign_wip');
});

test('scanSentinel: BLOCKED_BY_FOREIGN_WIP only matches at line start, like PASS/FAIL', () => {
  expect(scanSentinel(resultEventFor('I saw a SCHEDULER_VERDICT: BLOCKED_BY_FOREIGN_WIP mention mid-sentence'), [])).toBe(null);
});

test('scanSentinel: falls back to the last tool_result content when no resultEvent matches', () => {
  const events = [
    { kind: 'tool_result', seq: 1, toolUseId: 'a', content: 'nothing here' },
    { kind: 'tool_result', seq: 2, toolUseId: 'b', content: 'SCHEDULER_VERDICT: BLOCKED_BY_FOREIGN_WIP\nFOREIGN_WIP_PATHS: src/foo.ts' },
  ];
  expect(scanSentinel(null, events)).toBe('blocked_by_foreign_wip');
});

test('scanForeignWipPathsClaim: extracts a comma-separated FOREIGN_WIP_PATHS line from resultEvent', () => {
  const text = 'SCHEDULER_VERDICT: BLOCKED_BY_FOREIGN_WIP\nFOREIGN_WIP_PATHS: src/foo.ts, src/bar.ts';
  expect(scanForeignWipPathsClaim(resultEventFor(text), [])).toEqual(['src/foo.ts', 'src/bar.ts']);
});

test('scanForeignWipPathsClaim: dedupes and trims whitespace', () => {
  const text = 'FOREIGN_WIP_PATHS:  src/foo.ts ,src/foo.ts, src/bar.ts ';
  expect(scanForeignWipPathsClaim(resultEventFor(text), [])).toEqual(['src/foo.ts', 'src/bar.ts']);
});

test('scanForeignWipPathsClaim: returns [] when no FOREIGN_WIP_PATHS line is present', () => {
  expect(scanForeignWipPathsClaim(resultEventFor('SCHEDULER_VERDICT: FAIL nope'), [])).toEqual([]);
  expect(scanForeignWipPathsClaim(null, [])).toEqual([]);
});

test('scanForeignWipPathsClaim: falls back to the last tool_result content', () => {
  const events = [
    { kind: 'tool_result', seq: 1, toolUseId: 'a', content: 'FOREIGN_WIP_PATHS: src/stale.ts' },
    { kind: 'tool_result', seq: 2, toolUseId: 'b', content: 'FOREIGN_WIP_PATHS: src/latest.ts' },
  ];
  expect(scanForeignWipPathsClaim(null, events)).toEqual(['src/latest.ts']);
});

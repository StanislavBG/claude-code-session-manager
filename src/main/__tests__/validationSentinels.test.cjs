/**
 * validationSentinels.test.cjs — unit tests for parseValidationSentinels
 * (PRD 1407): a plan-level validator job ends its run with one
 * `VALIDATION: <slug> VERIFIED` or `VALIDATION: <slug> REFUTED — <reason>`
 * line per PRD; this module extracts those lines from the job's result text.
 *
 * Run: timeout 300 npx vitest run src/main/__tests__/validationSentinels.test.cjs
 */

'use strict';

import { test, expect } from 'vitest';
const { parseValidationSentinels } = require('../lib/validationSentinels.cjs');

test('parses a VERIFIED line with no reason', () => {
  expect(parseValidationSentinels('VALIDATION: 123-foo VERIFIED')).toEqual([
    { slug: '123-foo', verdict: 'verified', reason: '' },
  ]);
});

test('parses a REFUTED line with an em-dash reason', () => {
  expect(parseValidationSentinels('VALIDATION: 123-foo REFUTED — missing test coverage')).toEqual([
    { slug: '123-foo', verdict: 'refuted', reason: 'missing test coverage' },
  ]);
});

test('parses a REFUTED line with an en-dash reason', () => {
  expect(parseValidationSentinels('VALIDATION: 123-foo REFUTED – bad wiring')).toEqual([
    { slug: '123-foo', verdict: 'refuted', reason: 'bad wiring' },
  ]);
});

test('parses a REFUTED line with a hyphen reason', () => {
  expect(parseValidationSentinels('VALIDATION: 123-foo REFUTED - wrong file touched')).toEqual([
    { slug: '123-foo', verdict: 'refuted', reason: 'wrong file touched' },
  ]);
});

test('parses a REFUTED line with no reason', () => {
  expect(parseValidationSentinels('VALIDATION: 123-foo REFUTED')).toEqual([
    { slug: '123-foo', verdict: 'refuted', reason: '' },
  ]);
});

test('ignores lowercase verified/refuted', () => {
  expect(parseValidationSentinels('VALIDATION: 123-foo verified')).toEqual([]);
  expect(parseValidationSentinels('VALIDATION: 123-foo refuted')).toEqual([]);
});

test('ignores every other line in a multi-line transcript', () => {
  const text = [
    'Some preamble text',
    'Running gate...',
    'VALIDATION: 111-alpha VERIFIED',
    'random noise mentioning VALIDATION: not-a-real-line',
    'VALIDATION: 222-beta REFUTED — the fix was incomplete',
    'trailing notes',
  ].join('\n');

  expect(parseValidationSentinels(text)).toEqual([
    { slug: '111-alpha', verdict: 'verified', reason: '' },
    { slug: '222-beta', verdict: 'refuted', reason: 'the fix was incomplete' },
  ]);
});

test('last line per slug wins, order of first appearance kept', () => {
  const text = [
    'VALIDATION: 111-alpha VERIFIED',
    'VALIDATION: 222-beta REFUTED — first reason',
    'VALIDATION: 111-alpha REFUTED — actually broken',
    'VALIDATION: 222-beta VERIFIED',
  ].join('\n');

  expect(parseValidationSentinels(text)).toEqual([
    { slug: '111-alpha', verdict: 'refuted', reason: 'actually broken' },
    { slug: '222-beta', verdict: 'verified', reason: '' },
  ]);
});

test('returns [] for null, undefined, and empty input', () => {
  expect(parseValidationSentinels(null)).toEqual([]);
  expect(parseValidationSentinels(undefined)).toEqual([]);
  expect(parseValidationSentinels('')).toEqual([]);
});

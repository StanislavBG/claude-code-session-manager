/**
 * externalRef.test.cjs — normalizeExternalRef, the one shared validator every
 * entry point uses for an outside app's own id on an Epic, plus the stored
 * EpicSourceSchema shape (lenient: any string, so no row is ever dropped).
 *
 * Run: timeout 120 npx vitest run src/main/lib/epic/__tests__/externalRef.test.cjs
 */

'use strict';

import { test, expect } from 'vitest';
const { EXTERNAL_REF_MAX, EXTERNAL_REF_PATTERN, normalizeExternalRef } = require('../externalRef.cjs');
const { EpicSourceSchema } = require('../../promptSessionSchema.cjs');

test('exports the 200-char cap and a pattern', () => {
  expect(EXTERNAL_REF_MAX).toBe(200);
  expect(EXTERNAL_REF_PATTERN).toBeInstanceOf(RegExp);
});

test('absent → ok, undefined', () => {
  expect(normalizeExternalRef(undefined)).toEqual({ ok: true, value: undefined });
});

test('null → ok, undefined', () => {
  expect(normalizeExternalRef(null)).toEqual({ ok: true, value: undefined });
});

test('valid ref with every allowed punctuation → ok, unchanged', () => {
  const ref = 'portfolio:action/abc-123_x.y@v2';
  expect(normalizeExternalRef(ref)).toEqual({ ok: true, value: ref });
});

test('surrounding whitespace is trimmed', () => {
  expect(normalizeExternalRef('  self:42 \n')).toEqual({ ok: true, value: 'self:42' });
});

test('exactly 200 characters → ok', () => {
  expect(normalizeExternalRef('a'.repeat(200))).toEqual({ ok: true, value: 'a'.repeat(200) });
});

// The shape of a rejection: not ok, a non-empty error string, and no value.
const REJECTED = { ok: false, hasError: true, hasValue: false };
function rejection(value) {
  const r = normalizeExternalRef(value);
  return {
    ok: r.ok,
    hasError: typeof r.error === 'string' && r.error.length > 0,
    hasValue: Object.prototype.hasOwnProperty.call(r, 'value'),
  };
}

test('empty after trim → rejected', () => {
  expect(rejection('   ')).toEqual(REJECTED);
  expect(rejection('')).toEqual(REJECTED);
});

test('201 characters → rejected', () => {
  expect(rejection('a'.repeat(201))).toEqual(REJECTED);
});

test('a space inside → rejected', () => {
  expect(rejection('self 42')).toEqual(REJECTED);
});

test('a newline inside → rejected', () => {
  expect(rejection('self\n42')).toEqual(REJECTED);
});

test('a number → rejected, never thrown', () => {
  expect(rejection(42)).toEqual(REJECTED);
  expect(rejection({})).toEqual(REJECTED);
});

test('EpicSourceSchema parses a source without externalRef', () => {
  const r = EpicSourceSchema.safeParse({ producer: 'new-epic-ui' });
  expect(r.success).toBe(true);
  expect(r.data.externalRef).toBeUndefined();
});

test('EpicSourceSchema keeps any string externalRef, even one the validator would reject', () => {
  const odd = 'has spaces\nand a newline ' + 'x'.repeat(300);
  const r = EpicSourceSchema.safeParse({ producer: 'new-epic-ui', externalRef: odd });
  expect(r.success).toBe(true);
  expect(r.data.externalRef).toBe(odd);
});

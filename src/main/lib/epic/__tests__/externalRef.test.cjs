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

function expectRejected(value) {
  const r = normalizeExternalRef(value);
  expect(r.ok).toBe(false);
  expect(typeof r.error).toBe('string');
  expect(r.error.length).toBeGreaterThan(0);
  expect(r).not.toHaveProperty('value');
}

test('empty after trim → rejected', () => {
  expectRejected('   ');
  expectRejected('');
});

test('201 characters → rejected', () => {
  expectRejected('a'.repeat(201));
});

test('a space inside → rejected', () => {
  expectRejected('self 42');
});

test('a newline inside → rejected', () => {
  expectRejected('self\n42');
});

test('a number → rejected, never thrown', () => {
  expectRejected(42);
  expectRejected({});
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

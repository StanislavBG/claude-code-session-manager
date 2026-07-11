/**
 * extractJson.test.cjs — unit tests for lib/extractJson.cjs, the shared
 * brace-matching JSON extractor used by memoryAggregate.cjs and
 * chatRunner.cjs's parseStopSignal.
 *
 * Run: timeout 120 node --test src/main/__tests__/extractJson.test.cjs
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { extractJson } = require('../lib/extractJson.cjs');

test('plain JSON object → parsed object', () => {
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
});

test('JSON preceded by prose → parsed object', () => {
  assert.deepEqual(extractJson('Here you go:\n{"a":1}'), { a: 1 });
});

test('JSON followed by trailing prose → parsed object', () => {
  assert.deepEqual(extractJson('{"a":1}\nthanks!'), { a: 1 });
});

test('JSON wrapped in a code fence → parsed object', () => {
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
});

test('nested braces and braces inside strings are handled', () => {
  assert.deepEqual(extractJson('{"a":{"b":2},"c":"a } b"}'), { a: { b: 2 }, c: 'a } b' });
});

test('escaped quotes inside strings do not break brace matching', () => {
  assert.deepEqual(extractJson('{"a":"a \\" } b"}'), { a: 'a " } b' });
});

test('no opening brace → null', () => {
  assert.equal(extractJson('no json here'), null);
});

test('malformed JSON → null', () => {
  assert.equal(extractJson('{a: 1 unterminated'), null);
});

test('empty/nullish input → null', () => {
  assert.equal(extractJson(''), null);
  assert.equal(extractJson(null), null);
  assert.equal(extractJson(undefined), null);
});

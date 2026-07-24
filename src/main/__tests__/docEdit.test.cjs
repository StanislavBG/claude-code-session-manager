/**
 * docEdit.test.cjs — unit tests for docEdit.cjs's pure helpers (PRD 638).
 *
 * Run: timeout 300 npx vitest run src/main/__tests__/docEdit.test.cjs
 */

'use strict';

import { test, expect, describe } from 'vitest';
const { parseDocEdit } = require('../docEdit.cjs');
const { duplicateNameFor } = require('../files.cjs');

describe('parseDocEdit', () => {
  test('valid JSON', () => {
    const result = parseDocEdit('{"after":"rewritten text"}');
    expect(result).toEqual({ ok: true, after: 'rewritten text' });
  });

  test('JSON embedded in prose', () => {
    const result = parseDocEdit('Sure, here you go:\n{"after":"rewritten text"}\nHope that helps!');
    expect(result).toEqual({ ok: true, after: 'rewritten text' });
  });

  test('missing after', () => {
    const result = parseDocEdit('{"other":"value"}');
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });

  test('empty after', () => {
    const result = parseDocEdit('{"after":""}');
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });

  test('non-string after', () => {
    const result = parseDocEdit('{"after":42}');
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });

  test('over-length after', () => {
    const result = parseDocEdit(JSON.stringify({ after: 'x'.repeat(16001) }));
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });

  test('no JSON object in output at all', () => {
    const result = parseDocEdit('not json at all, just prose garbage');
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });

  test('empty/null input', () => {
    expect(parseDocEdit('').ok).toBe(false);
    expect(parseDocEdit(null).ok).toBe(false);
  });
});

describe('duplicateNameFor', () => {
  test('fresh name — no collision', () => {
    const result = duplicateNameFor('/tmp/dir', 'notes.txt', () => false);
    expect(result).toEqual({ ok: true, name: 'notes-copy.txt' });
  });

  test('collision on the first candidate falls through to -copy-2', () => {
    const taken = new Set(['/tmp/dir/notes-copy.txt']);
    const result = duplicateNameFor('/tmp/dir', 'notes.txt', (full) => taken.has(full));
    expect(result).toEqual({ ok: true, name: 'notes-copy-2.txt' });
  });

  test('preserves extension-less basenames', () => {
    const result = duplicateNameFor('/tmp/dir', 'README', () => false);
    expect(result).toEqual({ ok: true, name: 'README-copy' });
  });

  test('cap exhausted after 20 attempts returns an error', () => {
    const result = duplicateNameFor('/tmp/dir', 'notes.txt', () => true);
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });
});

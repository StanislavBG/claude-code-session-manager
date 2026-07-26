/**
 * docEdit.test.cjs — unit tests for docEdit.cjs's pure helpers (PRD 638).
 *
 * Run: timeout 300 npx vitest run src/main/__tests__/docEdit.test.cjs
 */

'use strict';

import { test, expect, describe } from 'vitest';
const { parseDocEdit, editPrompt, truncateDocumentText, MAX_DOC_CONTEXT } = require('../docEdit.cjs');
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

describe('editPrompt', () => {
  test('omits the document block when documentText is absent', () => {
    const prompt = editPrompt('selected text', 'make it concise');
    expect(prompt).not.toMatch(/<document_/);
  });

  test('includes a nonce-tagged document block when documentText is provided', () => {
    const prompt = editPrompt('selected text', 'make it concise', 'the whole document');
    expect(prompt).toMatch(/<document_[0-9a-f]+>/);
    expect(prompt).toContain('the whole document');
  });

  test('truncates an oversized documentText before embedding it', () => {
    const huge = 'x'.repeat(MAX_DOC_CONTEXT + 5000);
    const prompt = editPrompt('selected text', 'make it concise', huge);
    expect(prompt).toContain('[...document truncated for length...]');
    expect(prompt.length).toBeLessThan(huge.length + 2000);
  });
});

describe('truncateDocumentText', () => {
  test('passes short text through unchanged', () => {
    expect(truncateDocumentText('short')).toBe('short');
  });

  test('truncates to the documented head+tail scheme rather than dropping or erroring', () => {
    const head = 'H'.repeat(40000);
    const tail = 'T'.repeat(20000);
    const middle = 'M'.repeat(10000);
    const result = truncateDocumentText(head + middle + tail);
    expect(result).toBe(`${head}\n\n[...document truncated for length...]\n\n${tail}`);
    expect(result).not.toContain('M');
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

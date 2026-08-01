/**
 * toolUseClassify.test.cjs — unit tests for src/main/lib/toolUseClassify.cjs.
 *
 * Run: timeout 120 npx vitest run src/main/lib/__tests__/toolUseClassify.test.cjs
 */

'use strict';

import { test, expect } from 'vitest';

const { classifyToolUse, MAX_DIFF_STR } = require('../toolUseClassify.cjs');

test('Edit tool_use produces a diff payload with filePath/oldText/newText', () => {
  const block = {
    name: 'Edit',
    input: { file_path: '/tmp/foo.js', old_string: 'a', new_string: 'b' },
  };
  const result = classifyToolUse(block);
  expect(result.kind).toBe('tool');
  expect(result.diff).toEqual({ filePath: '/tmp/foo.js', oldText: 'a', newText: 'b' });
});

test('Write tool_use produces a diff payload with filePath/newText only', () => {
  const block = { name: 'Write', input: { file_path: '/tmp/bar.js', content: 'hello' } };
  const result = classifyToolUse(block);
  expect(result.diff).toEqual({ filePath: '/tmp/bar.js', newText: 'hello' });
});

test('non-Edit/Write tool_use has no diff field', () => {
  const block = { name: 'Bash', input: { command: 'ls' } };
  const result = classifyToolUse(block);
  expect(result.diff).toBeUndefined();
  expect('diff' in result).toBe(false);
});

test('Skill/mcp tool_use never get a diff field', () => {
  expect(classifyToolUse({ name: 'Skill', input: { skill: 'x' } }).diff).toBeUndefined();
  expect(classifyToolUse({ name: 'mcp__foo__bar', input: {} }).diff).toBeUndefined();
});

test('oversized Edit strings are capped at MAX_DIFF_STR', () => {
  const big = 'x'.repeat(MAX_DIFF_STR + 100);
  const block = { name: 'Edit', input: { file_path: '/tmp/foo.js', old_string: big, new_string: big } };
  const result = classifyToolUse(block);
  expect(result.diff.oldText.length).toBe(MAX_DIFF_STR + 1); // + ellipsis char
  expect(result.diff.oldText.endsWith('…')).toBe(true);
});

test('Edit block missing file_path yields no diff', () => {
  const block = { name: 'Edit', input: { old_string: 'a', new_string: 'b' } };
  const result = classifyToolUse(block);
  expect(result.diff).toBeUndefined();
});

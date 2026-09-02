/**
 * prdDeclaredPaths.test.cjs — extracting a PRD's declared file paths for the
 * reverify self-heal pass's widened evidence window (PRD 1102).
 *
 * Run: timeout 120 npx vitest run src/main/lib/__tests__/prdDeclaredPaths.test.cjs
 */

'use strict';

import { test } from 'vitest';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { extractDeclaredPaths, declaredPathsForPrd } = require('../prdDeclaredPaths.cjs');

test('extracts backtick-quoted paths from Implementation notes', () => {
  const body = [
    '# Implementation notes',
    '',
    'Edit `src/main/scheduler.cjs` and `src/main/lib/gitWorktree.cjs`.',
    '',
    '# Out of scope',
    'Do not touch `src/main/should-not-appear.cjs` here.',
  ].join('\n');
  const paths = extractDeclaredPaths(body);
  assert.deepStrictEqual(paths, ['src/main/scheduler.cjs', 'src/main/lib/gitWorktree.cjs']);
});

test('extracts paths from Acceptance criteria and strips trailing :line', () => {
  const body = [
    '# Acceptance criteria',
    '- [ ] Fix the bug in `src/main/scheduler.cjs:490`',
  ].join('\n');
  assert.deepStrictEqual(extractDeclaredPaths(body), ['src/main/scheduler.cjs']);
});

test('dedupes paths mentioned in both sections', () => {
  const body = [
    '# Acceptance criteria',
    '- [ ] Fix `src/main/scheduler.cjs`',
    '# Implementation notes',
    'See `src/main/scheduler.cjs` again.',
  ].join('\n');
  assert.deepStrictEqual(extractDeclaredPaths(body), ['src/main/scheduler.cjs']);
});

test('never fabricates a path — no match anywhere returns []', () => {
  const body = [
    '# Implementation notes',
    'Just prose, no backticked paths here.',
    '# Acceptance criteria',
    '- [ ] npm run typecheck passes',
  ].join('\n');
  assert.deepStrictEqual(extractDeclaredPaths(body), []);
});

test('empty/non-string body returns []', () => {
  assert.deepStrictEqual(extractDeclaredPaths(''), []);
  assert.deepStrictEqual(extractDeclaredPaths(null), []);
});

test('declaredPathsForPrd reads a real file and strips frontmatter', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prd-declared-paths-'));
  const prdPath = path.join(dir, '01-test.md');
  fs.writeFileSync(prdPath, [
    '---',
    'title: Test',
    '---',
    '# Implementation notes',
    'Touch `src/main/scheduler.cjs`.',
  ].join('\n'));
  assert.deepStrictEqual(declaredPathsForPrd(prdPath), ['src/main/scheduler.cjs']);
});

test('declaredPathsForPrd on a missing file returns [] without throwing', () => {
  assert.deepStrictEqual(declaredPathsForPrd('/nonexistent/path/does-not-exist.md'), []);
});

test('declaredPathsForPrd with null path returns []', () => {
  assert.deepStrictEqual(declaredPathsForPrd(null), []);
});

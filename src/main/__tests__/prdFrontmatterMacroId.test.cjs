/**
 * prdFrontmatterMacroId.test.cjs — `macroId` (the macro whose press
 * dispatched the PRD) is a recognized frontmatter key.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/prdFrontmatterMacroId.test.cjs
 */

'use strict';

import { test, expect } from 'vitest';

const { parsePrdFile, serializePrdFile, RECOGNIZED_KEYS } = require('../lib/prd/prdFrontmatter.cjs');

test('macroId is a recognized key', () => {
  expect(RECOGNIZED_KEYS.has('macroId')).toBe(true);
});

test('macroId parses and round-trips, emitted right after artifactPaths', () => {
  const text = '---\ntitle: T\nartifactPaths: [a.txt]\nmacroId: demo-video_1.v2\n---\nbody\n';
  const { frontmatter, body } = parsePrdFile(text);
  expect(frontmatter.macroId).toBe('demo-video_1.v2');
  expect(frontmatter.extras?.macroId).toBeUndefined();
  const out = serializePrdFile(frontmatter, body);
  expect(out).toMatch(/artifactPaths: \[a\.txt\]\nmacroId: demo-video_1\.v2\n/);
  expect(parsePrdFile(out).frontmatter.macroId).toBe('demo-video_1.v2');
});

test('invalid macroId values are dropped', () => {
  for (const bad of ['has space', '-lead', '.dot', 'a/b', 'x'.repeat(129)]) {
    const { frontmatter } = parsePrdFile(`---\ntitle: T\nmacroId: ${bad}\n---\nbody\n`);
    expect(frontmatter.macroId).toBeUndefined();
  }
});

test('quoted macroId is unquoted and trimmed', () => {
  const { frontmatter } = parsePrdFile('---\ntitle: T\nmacroId:   "abc-1"  \n---\nb\n');
  expect(frontmatter.macroId).toBe('abc-1');
});

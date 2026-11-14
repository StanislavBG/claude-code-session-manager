/**
 * prdFrontmatterArtifact.test.cjs — the one definition of an artifact-only
 * PRD declaration (isArtifactOnlyDeclaration) and the shared inline-list
 * parser (parseInlineList) that prdParser.cjs's parseArtifactPaths delegates to.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/prdFrontmatterArtifact.test.cjs
 */

'use strict';

import { test, expect } from 'vitest';

const { isArtifactOnlyDeclaration, parseInlineList } = require('../lib/prd/prdFrontmatter.cjs');

test('isArtifactOnlyDeclaration: artifact deliverable with a non-empty artifactPaths list is true', () => {
  expect(isArtifactOnlyDeclaration({ deliverable: 'artifact', artifactPaths: ['a.html'] })).toBe(true);
});

test('isArtifactOnlyDeclaration: null and undefined are false', () => {
  expect(isArtifactOnlyDeclaration(null)).toBe(false);
  expect(isArtifactOnlyDeclaration(undefined)).toBe(false);
});

test('isArtifactOnlyDeclaration: missing or different deliverable is false', () => {
  expect(isArtifactOnlyDeclaration({ artifactPaths: ['a'] })).toBe(false);
  expect(isArtifactOnlyDeclaration({ deliverable: 'code', artifactPaths: ['a'] })).toBe(false);
});

test('isArtifactOnlyDeclaration: missing, empty or non-array artifactPaths is false', () => {
  expect(isArtifactOnlyDeclaration({ deliverable: 'artifact' })).toBe(false);
  expect(isArtifactOnlyDeclaration({ deliverable: 'artifact', artifactPaths: [] })).toBe(false);
  expect(isArtifactOnlyDeclaration({ deliverable: 'artifact', artifactPaths: 'a.html' })).toBe(false);
  expect(isArtifactOnlyDeclaration({ deliverable: 'artifact', artifactPaths: null })).toBe(false);
});

test('parseInlineList: strips quotes from entries', () => {
  expect(parseInlineList(`["a.html", 'b.md', c]`)).toEqual(['a.html', 'b.md', 'c']);
});

test('parseInlineList: empty brackets give []', () => {
  expect(parseInlineList('[]')).toEqual([]);
  expect(parseInlineList('[  ]')).toEqual([]);
});

test('parseInlineList: a non-bracketed value gives null', () => {
  expect(parseInlineList('a.html')).toBeNull();
});

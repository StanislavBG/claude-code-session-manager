/**
 * readability.test.cjs — makes "easy to read for a high-school diploma" a
 * checkable gate. Exercises web/manual/readability.mjs directly (dynamic
 * `import()`, same pattern as src/main/__tests__/chat-preamble-anchors.test.cjs,
 * since a plain ESM module can't be `require()`d from this .cjs test file).
 *
 * Run: timeout 120 npx vitest run web/manual/__tests__/readability.test.cjs
 */

'use strict';

import { test, expect } from 'vitest';
const path = require('node:path');

async function loadReadability() {
  return import(/* @vite-ignore */ path.resolve(__dirname, '..', 'readability.mjs'));
}

test('a plain sentence grades below 5', async () => {
  const { analyzeChapter } = await loadReadability();
  const html = '<p>The cat sat on the mat.</p><p>The dog ran fast.</p>';
  const { grade } = analyzeChapter(html);
  expect(grade).toBeLessThan(5);
});

test('a dense academic sentence grades above 12', async () => {
  const { analyzeChapter } = await loadReadability();
  const html =
    '<p>The epistemological ramifications of postmodern hermeneutical interpretation ' +
    'necessitate an interdisciplinary reconceptualization of institutionalized pedagogical ' +
    'methodologies, particularly regarding the multifaceted socioeconomic determinants ' +
    'underlying contemporary organizational bureaucratization.</p>';
  const { grade } = analyzeChapter(html);
  expect(grade).toBeGreaterThan(12);
});

test('code blocks are ignored', async () => {
  const { htmlToProse, analyzeChapter } = await loadReadability();
  const html =
    '<p>Run this command.</p>' +
    '<pre><code>function veryLongComplicatedIdentifierNameThatWouldWreckTheGrade() { return 1; }</code></pre>' +
    '<p>Then read the output.</p>';

  const prose = htmlToProse(html);
  expect(prose).not.toMatch(/veryLongComplicatedIdentifierNameThatWouldWreckTheGrade/);

  const { words } = analyzeChapter(html);
  expect(words).toBe(7); // "Run this command." + "Then read the output." only
});

test('list items count as sentences', async () => {
  const { analyzeChapter } = await loadReadability();
  const html = '<ul><li>First item</li><li>Second item</li><li>Third item</li></ul>';
  const { sentences } = analyzeChapter(html);
  expect(sentences).toBe(3);
});

test('countSyllables drops a trailing silent e but not in "le"', async () => {
  const { countSyllables } = await loadReadability();
  expect(countSyllables('time')).toBe(1);
  expect(countSyllables('little')).toBe(2);
});

test('fleschKincaidGrade returns 0 for empty text', async () => {
  const { fleschKincaidGrade } = await loadReadability();
  expect(fleschKincaidGrade('')).toBe(0);
});

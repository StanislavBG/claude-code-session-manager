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

// ── markdownToProse ─────────────────────────────────────────────────────────

function sentenceCount(text) {
  return text
    .split(/[.!?]+/)
    .map((s) => s.trim())
    .filter(Boolean).length;
}

test('markdownToProse returns an empty string for empty or missing input', async () => {
  const { markdownToProse } = await loadReadability();
  expect(markdownToProse('')).toBe('');
  expect(markdownToProse(undefined)).toBe('');
});

test('markdownToProse drops fenced code blocks (backticks and tildes)', async () => {
  const { markdownToProse } = await loadReadability();
  const md = 'Run this.\n\n```bash\nnpm install secretbacktick\n```\n\n~~~\nsecrettilde --flag\n~~~\n\nDone now.';
  const prose = markdownToProse(md);
  expect(prose).not.toMatch(/secretbacktick|secrettilde|npm|```|~~~/);
  expect(prose).toBe('Run this. Done now.');
});

test('markdownToProse drops inline code spans', async () => {
  const { markdownToProse } = await loadReadability();
  expect(markdownToProse('Type `npm run secretcode` to start.')).toBe('Type to start.');
});

test('markdownToProse drops HTML comments', async () => {
  const { markdownToProse } = await loadReadability();
  const prose = markdownToProse('Keep this.<!-- hidden\nsecretcomment -->\n\nAnd this.');
  expect(prose).not.toMatch(/hidden|secretcomment/);
  expect(prose).toBe('Keep this. And this.');
});

test('markdownToProse drops HTML tags but keeps their text', async () => {
  const { markdownToProse } = await loadReadability();
  const prose = markdownToProse('<p align="center">Hello <b>there</b></p>');
  expect(prose).not.toMatch(/[<>]|align/);
  expect(prose).toBe('Hello there.');
});

test('markdownToProse drops images', async () => {
  const { markdownToProse } = await loadReadability();
  const prose = markdownToProse('Look here ![secretalt](https://x.test/a.png) now.');
  expect(prose).not.toMatch(/secretalt|png|https/);
  expect(prose).toBe('Look here now.');
});

test('markdownToProse drops autolinks', async () => {
  const { markdownToProse } = await loadReadability();
  const prose = markdownToProse('Visit <https://secret.test/path> today.');
  expect(prose).not.toMatch(/secret|https/);
  expect(prose).toBe('Visit today.');
});

test('markdownToProse drops bare http(s) URLs', async () => {
  const { markdownToProse } = await loadReadability();
  const prose = markdownToProse('See https://secret.test/a?b=c and http://other.test for more.');
  expect(prose).not.toMatch(/secret|other|http/);
  expect(prose).toBe('See and for more.');
});

test('markdownToProse keeps link text and drops the link target', async () => {
  const { markdownToProse } = await loadReadability();
  expect(markdownToProse('[Docs](https://x)')).toBe('Docs.');
  expect(markdownToProse('Read the [full guide](https://x.test/guide "Title") first.')).toBe(
    'Read the full guide first.',
  );
});

test('markdownToProse ends a sentence after headings, list items and blockquotes', async () => {
  const { markdownToProse } = await loadReadability();
  const md = '# Title\n## Sub title!\n- one\n* two\n1. three\n> quoted line';
  const prose = markdownToProse(md);
  expect(prose).toBe('Title. Sub title! one. two. three. quoted line.');
  expect(sentenceCount(prose)).toBe(6);
});

test('markdownToProse ends a paragraph at a blank line and strips emphasis markers', async () => {
  const { markdownToProse } = await loadReadability();
  const md = 'This is **bold** and __strong__\ntext here\n\nNext paragraph';
  expect(markdownToProse(md)).toBe('This is bold and strong text here. Next paragraph.');
});

test('markdownToProse: a 3-cell table row yields 3 sentences and separators are dropped', async () => {
  const { markdownToProse } = await loadReadability();
  const row = markdownToProse('| Alpha | Beta | Gamma |');
  expect(row).toBe('Alpha. Beta. Gamma.');
  expect(sentenceCount(row)).toBe(3);

  const table = markdownToProse('| Name | Use |\n| :--- | ---: |\n| One | Two |');
  expect(table).not.toMatch(/[|:-]/);
  expect(sentenceCount(table)).toBe(4);
});

test('markdownToProse: a fenced block of long words does not change the grade', async () => {
  const { markdownToProse, fleschKincaidGrade } = await loadReadability();
  const plain = 'The cat sat on the mat.\n\nThe dog ran fast.';
  const fenced =
    'The cat sat on the mat.\n\n```\n' +
    'epistemological hermeneutical reconceptualization institutionalized bureaucratization\n' +
    '```\n\nThe dog ran fast.';
  expect(fleschKincaidGrade(markdownToProse(fenced))).toBe(fleschKincaidGrade(markdownToProse(plain)));
});

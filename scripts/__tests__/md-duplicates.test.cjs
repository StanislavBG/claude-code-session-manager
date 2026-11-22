/**
 * md-duplicates.test.cjs — findDuplicates() from the maintaining-md-network mdDuplicates.cjs primitive.
 * Run: timeout 120 npx vitest run scripts/__tests__/md-duplicates.test.cjs
 */

'use strict';

import { test, expect } from 'vitest';
const path = require('node:path');

const { findDuplicates, normalize, LIMITS } = require(path.resolve(
  __dirname,
  '../../plugins/session-manager-dev/skills/maintaining-md-network/scripts/mdDuplicates.cjs',
));

// Deterministic filler: distinct words per seed so unrelated docs share no 8-word run.
function filler(seed, n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(`w${seed}x${i}`);
  return out.join(' ');
}

const SHARED =
  'The scheduler runs every PRD as a headless claude job inside its own git worktree, ' +
  'and the job must commit its exact paths before it prints the verdict line that the ' +
  'scheduler reads to decide whether the work landed or needs a human review.';

test('no overlap returns []', () => {
  const docs = [
    { path: 'a.md', text: filler('a', 200) },
    { path: 'b.md', text: filler('b', 200) },
  ];
  expect(findDuplicates(docs)).toEqual([]);
  expect(findDuplicates([])).toEqual([]);
});

test('a shared paragraph is found with its sample', () => {
  const docs = [
    { path: 'a.md', text: `# Alpha\n\n${filler('a', 50)}\n\n**${SHARED}**\n\n${filler('a2', 50)}` },
    { path: 'b.md', text: `# Beta\n\n${filler('b', 30)}\n\n- ${SHARED}\n\n${filler('b2', 30)}` },
    { path: 'c.md', text: filler('c', 100) },
  ];
  const pairs = findDuplicates(docs);
  expect(pairs).toHaveLength(1);
  const [p] = pairs;
  expect(p.a).toBe('a.md');
  expect(p.b).toBe('b.md');
  expect(p.copy).toBeFalsy();
  // 44 words in SHARED → 37 shared 8-word runs.
  expect(p.sharedRuns).toBe(37);
  expect(p.samples.length).toBeGreaterThanOrEqual(1);
  expect(p.samples.length).toBeLessThanOrEqual(3);
  for (const s of p.samples) expect(s.length).toBeLessThanOrEqual(200);
  expect(p.samples[0].startsWith('the scheduler runs every prd as a headless claude job')).toBe(true);
});

test('normalization drops code blocks and link targets, keeps link text, strips punctuation', () => {
  const n = normalize('See [The Guide](docs/guide.md) **now**!\n\n```js\nconst x = 1;\n```\nDone.');
  expect(n).toEqual(['see', 'the', 'guide', 'now', 'done']);
});

test('code blocks are ignored', () => {
  const fence = '```\n' + SHARED + '\n```';
  const docs = [
    { path: 'a.md', text: `${filler('a', 40)}\n\n${fence}\n\n${filler('a2', 40)}` },
    { path: 'b.md', text: `${filler('b', 40)}\n\n~~~sh\n${SHARED}\n~~~\n\n${filler('b2', 40)}` },
  ];
  expect(findDuplicates(docs)).toEqual([]);
});

test('link targets differing does not hide shared link text', () => {
  const linked = SHARED.replace('git worktree', '[git worktree](x/y.md)');
  const linked2 = SHARED.replace('git worktree', '[git worktree](../other/z.md)');
  const docs = [
    { path: 'a.md', text: `${filler('a', 40)}\n${linked}\n${filler('a2', 40)}` },
    { path: 'b.md', text: `${filler('b', 40)}\n${linked2}\n${filler('b2', 40)}` },
  ];
  expect(findDuplicates(docs)[0].sharedRuns).toBe(37);
});

test('minRuns threshold respected', () => {
  // 17 shared words → 10 shared runs at runWords 8.
  const shared = filler('s', 17);
  const docs = [
    { path: 'a.md', text: `${filler('a', 40)} ${shared} ${filler('a2', 40)}` },
    { path: 'b.md', text: `${filler('b', 40)} ${shared} ${filler('b2', 40)}` },
  ];
  expect(findDuplicates(docs)).toHaveLength(1);
  expect(findDuplicates(docs)[0].sharedRuns).toBe(10);
  expect(findDuplicates(docs, { minRuns: 11 })).toEqual([]);
  // A smaller runWords yields more runs from the same overlap.
  expect(findDuplicates(docs, { runWords: 4 })[0].sharedRuns).toBe(14);
});

test('results sorted by sharedRuns descending', () => {
  const big = filler('big', 60);
  const small = filler('small', 25);
  const docs = [
    { path: 'a.md', text: `${filler('a', 20)} ${small} ${filler('a2', 20)}` },
    { path: 'b.md', text: `${filler('b', 20)} ${small} ${filler('b2', 20)} ${big}` },
    { path: 'c.md', text: `${filler('c', 20)} ${big} ${filler('c2', 20)}` },
  ];
  const pairs = findDuplicates(docs);
  expect(pairs.map((p) => [p.a, p.b])).toEqual([['b.md', 'c.md'], ['a.md', 'b.md']]);
  expect(pairs[0].sharedRuns).toBeGreaterThan(pairs[1].sharedRuns);
});

test('copy flag: two near-identical docs reported once with copy: true', () => {
  const body = filler('doc', 300);
  const docs = [
    { path: 'a.md', text: `# Title\n\n${body}` },
    { path: 'b.md', text: `# Title\n\n${body} one extra tail` },
    { path: 'c.md', text: `${filler('c', 100)} ${filler('doc', 30)} ${filler('c2', 100)}` },
  ];
  const pairs = findDuplicates(docs);
  const ab = pairs.filter((p) => p.a === 'a.md' && p.b === 'b.md');
  expect(ab).toHaveLength(1);
  expect(ab[0].copy).toBe(true);
  const partial = pairs.find((p) => p.b === 'c.md' || p.a === 'c.md');
  expect(partial).toBeTruthy();
  expect(partial.copy).toBeFalsy();
});

test('boilerplate cap: runs shared by more than maxDocsPerRun docs are ignored', () => {
  const boiler = filler('boiler', 40);
  const mk = (n) =>
    Array.from({ length: n }, (_, i) => ({ path: `d${i}.md`, text: `${filler(`u${i}`, 30)} ${boiler} ${filler(`v${i}`, 30)}` }));
  expect(findDuplicates(mk(6))).toHaveLength(15); // 6 docs → every pair reported
  expect(findDuplicates(mk(7))).toEqual([]); // 7 docs > cap of 6 → boilerplate
  expect(findDuplicates(mk(7), { maxDocsPerRun: 7 })).toHaveLength(21);
});

test('bounded: docs past the cap are ignored and long text is truncated', () => {
  expect(LIMITS.maxDocs).toBe(2000);
  expect(LIMITS.maxDocBytes).toBe(256 * 1024);
  const shared = filler('s', 40);
  const pad = 'x'.repeat(LIMITS.maxDocBytes + 10);
  const docs = [
    { path: 'a.md', text: `${pad} ${shared}` },
    { path: 'b.md', text: `${filler('b', 10)} ${shared}` },
  ];
  expect(findDuplicates(docs)).toEqual([]); // shared text lies beyond a.md's truncation point
  const many = Array.from({ length: LIMITS.maxDocs }, (_, i) => ({ path: `f${i}.md`, text: `w${i}` }));
  many.push({ path: 'late1.md', text: shared }, { path: 'late2.md', text: shared });
  expect(findDuplicates(many)).toEqual([]);
});

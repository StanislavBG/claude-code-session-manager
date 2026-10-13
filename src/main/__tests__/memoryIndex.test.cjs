'use strict';

import { test } from 'vitest';
const assert = require('node:assert/strict');
const { parseIndex, addIndexLine, removeIndexLines, indexHealth } = require('../lib/memoryIndex.cjs');

test('parseIndex extracts link lines with hooks and ignores others', () => {
  const text = [
    '# Memory',
    '- [A](a.md) — hook a',
    '- [B](b.md) - hook b',
    '- [C](c.md)',
    'plain text',
    '- [Ext](https://x.com/page)',
    '',
  ].join('\n');
  const r = parseIndex(text);
  assert.deepEqual(r.map((e) => [e.lineNo, e.title, e.file, e.hook]), [
    [2, 'A', 'a.md', 'hook a'],
    [3, 'B', 'b.md', 'hook b'],
    [4, 'C', 'c.md', ''],
  ]);
  assert.equal(r[0].line, '- [A](a.md) — hook a');
});

test('parseIndex handles CRLF and null', () => {
  const r = parseIndex('- [A](a.md) — h\r\n- [B](b.md)\r\n');
  assert.equal(r.length, 2);
  assert.equal(r[0].hook, 'h');
  assert.equal(r[0].line, '- [A](a.md) — h');
  assert.deepEqual(parseIndex(null), []);
});

test('parseIndex ignores links into subfolders', () => {
  assert.deepEqual(parseIndex('- [X](sub/x.md) — h\n'), []);
});

test('addIndexLine appends with and without hook', () => {
  assert.equal(addIndexLine('- [A](a.md)\n', { file: 'b.md', title: 'B', hook: 'hb' }), '- [A](a.md)\n- [B](b.md) — hb\n');
  assert.equal(addIndexLine('', { file: 'b.md', title: 'B', hook: '' }), '- [B](b.md)\n');
  assert.equal(addIndexLine(null, { file: 'b.md', title: 'B' }), '- [B](b.md)\n');
});

test('addIndexLine normalizes to one trailing newline', () => {
  assert.equal(addIndexLine('- [A](a.md)\n\n\n', { file: 'b.md', title: 'B', hook: '' }), '- [A](a.md)\n- [B](b.md)\n');
  assert.equal(addIndexLine('- [A](a.md)', { file: 'b.md', title: 'B', hook: '' }), '- [A](a.md)\n- [B](b.md)\n');
});

test('addIndexLine is a no-op when file already linked', () => {
  const t = '- [A](a.md) — x\n\n\n';
  assert.equal(addIndexLine(t, { file: 'a.md', title: 'Other', hook: 'y' }), t);
});

test('removeIndexLines removes only matching lines, others byte-identical', () => {
  const t = '# H\r\n- [A](a.md) — x\r\n- [B](b.md)\r\n\r\ntext';
  assert.equal(removeIndexLines(t, 'a.md'), '# H\r\n- [B](b.md)\r\n\r\ntext');
  assert.equal(removeIndexLines(t, 'zzz.md'), t);
  assert.equal(removeIndexLines('- [A](a.md)\n- [A2](a.md)\n', 'a.md'), '');
});

test('indexHealth reports orphans and dangling, sorted, excluding MEMORY.md', () => {
  const h = indexHealth({
    indexText: '- [Z](z.md)\n- [A](a.md)\n- [G](gone2.md)\n- [G](gone1.md)\n',
    files: ['MEMORY.md', 'z.md', 'a.md', 'o2.md', 'o1.md'],
  });
  assert.deepEqual(h.orphans, ['o1.md', 'o2.md']);
  assert.deepEqual(h.dangling, ['gone1.md', 'gone2.md']);
  assert.equal(h.lines, 4);
  assert.equal(h.maxLines, 200);
  assert.equal(h.maxBytes, 25600);
  assert.equal(h.overBudget, false);
  assert.equal(h.nearBudget, false);
});

test('indexHealth with null indexText', () => {
  const h = indexHealth({ indexText: null, files: ['MEMORY.md', 'b.md', 'a.md'] });
  assert.equal(h.lines, 0);
  assert.equal(h.bytes, 0);
  assert.deepEqual(h.orphans, ['a.md', 'b.md']);
  assert.deepEqual(h.dangling, []);
  assert.equal(h.overBudget, false);
});

test('indexHealth subfolder link does not count as linking a bare file', () => {
  const h = indexHealth({ indexText: '- [X](sub/x.md)\n', files: ['x.md'] });
  assert.deepEqual(h.orphans, ['x.md']);
  assert.deepEqual(h.dangling, []);
});

test('indexHealth line boundaries: 179 ok, 180 near, 200 near, 201 over', () => {
  const mk = (n) => 'x\n'.repeat(n);
  const h = (n) => indexHealth({ indexText: mk(n), files: [] });
  assert.equal(h(179).nearBudget, false);
  assert.equal(h(180).nearBudget, true);
  assert.equal(h(200).nearBudget, true);
  assert.equal(h(200).overBudget, false);
  assert.equal(h(201).overBudget, true);
  assert.equal(h(201).nearBudget, false);
  assert.equal(h(200).lines, 200);
});

test('indexHealth byte boundaries: 23039 ok, 23040 near, 25600 near, 25601 over', () => {
  const h = (n) => indexHealth({ indexText: 'a'.repeat(n), files: [] });
  assert.equal(h(23039).nearBudget, false);
  assert.equal(h(23040).nearBudget, true);
  assert.equal(h(25600).overBudget, false);
  assert.equal(h(25600).nearBudget, true);
  assert.equal(h(25601).overBudget, true);
  assert.equal(h(25601).nearBudget, false);
  // bytes are UTF-8, not chars
  assert.equal(indexHealth({ indexText: '—', files: [] }).bytes, 3);
});

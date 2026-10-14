'use strict';

import { test } from 'vitest';
const assert = require('node:assert/strict');
const path = require('node:path');
const { collectMdNetwork } = require('../lib/memoryMdNetwork.cjs');

const CWD = '/proj';
function fsOf(files) {
  return (p) => {
    const rel = path.relative(CWD, p);
    if (!(rel in files)) throw new Error('ENOENT');
    return files[rel];
  };
}

test('extracts md links, strips anchors, drops untracked links', () => {
  const files = {
    'CLAUDE.md': '# Root\n[a](docs/a.md#sec) [b](docs/missing.md) [x](https://x.com/y.md) [u](../up.md)',
    'docs/a.md': '# Doc A\nbody',
  };
  const r = collectMdNetwork({
    cwd: CWD, memoryBody: '', trackedFiles: ['CLAUDE.md', 'docs/a.md'], readFile: fsOf(files),
  });
  assert.deepEqual(r.docs.map((d) => d.path), ['docs/a.md']);
  assert.equal(r.docs[0].title, 'Doc A');
});

test('includes tracked scoped CLAUDE.md, excludes root, title falls back to path', () => {
  const files = { 'CLAUDE.md': '# Root', 'src/CLAUDE.md': 'no heading' };
  const r = collectMdNetwork({
    cwd: CWD, memoryBody: '', trackedFiles: ['CLAUDE.md', 'src/CLAUDE.md'], readFile: fsOf(files),
  });
  assert.deepEqual(r.docs, [{ path: 'src/CLAUDE.md', title: 'src/CLAUDE.md', bytes: 10 }]);
});

test('coverage hit carries line number and trimmed text, root searched', () => {
  const files = { 'CLAUDE.md': '# Root\n  use `opsPath` always  ', 'src/CLAUDE.md': 'x\nopsPath here' };
  const r = collectMdNetwork({
    cwd: CWD, memoryBody: 'see `opsPath` and `nope_term`', trackedFiles: ['src/CLAUDE.md'], readFile: fsOf(files),
  });
  const c = r.coverage.find((e) => e.term === 'opsPath');
  assert.deepEqual(c.hits, [
    { path: 'CLAUDE.md', line: 2, text: 'use `opsPath` always' },
    { path: 'src/CLAUDE.md', line: 2, text: 'opsPath here' },
  ]);
  assert.deepEqual(r.coverage.find((e) => e.term === 'nope_term').hits, []);
});

test('hit caps: 3 per doc, 8 total, 200 chars', () => {
  const many = Array.from({ length: 10 }, () => 'term_x ' + 'z'.repeat(300)).join('\n');
  const files = { 'CLAUDE.md': many };
  for (let i = 0; i < 4; i++) files[`d${i}/CLAUDE.md`] = many;
  const r = collectMdNetwork({
    cwd: CWD, memoryBody: '`term_x`', trackedFiles: Object.keys(files), readFile: fsOf(files),
  });
  const hits = r.coverage[0].hits;
  assert.equal(hits.length, 8);
  assert.equal(hits.filter((h) => h.path === 'CLAUDE.md').length, 3);
  assert.equal(hits[0].text.length, 200);
});

test('terms capped at 25, deduped, short ones dropped', () => {
  const body = Array.from({ length: 40 }, (_, i) => `\`term${i}\``).join(' ') + ' `ab` `term1`';
  const r = collectMdNetwork({ cwd: CWD, memoryBody: body, trackedFiles: [], readFile: fsOf({}) });
  assert.equal(r.coverage.length, 25);
  assert.equal(new Set(r.coverage.map((c) => c.term)).size, 25);
});

test('missing files are skipped; oversized docs listed but not searched; root truncated', () => {
  const files = {
    'CLAUDE.md': 'R'.repeat(20 * 1024) + '\n[g](gone.md) [b](big.md)',
    'big.md': '# Big\nneedle ' + 'x'.repeat(201 * 1024),
  };
  const r = collectMdNetwork({
    cwd: CWD, memoryBody: '`needle`', trackedFiles: ['CLAUDE.md', 'gone.md', 'big.md'], readFile: fsOf(files),
  });
  assert.equal(r.rootClaudeMd.length, 16 * 1024);
  assert.deepEqual(r.docs.map((d) => d.path), ['big.md']);
  assert.deepEqual(r.coverage[0].hits, []);
});

test('missing root CLAUDE.md yields empty network without throwing', () => {
  const r = collectMdNetwork({ cwd: CWD, memoryBody: '`abcd`', trackedFiles: [], readFile: fsOf({}) });
  assert.equal(r.rootClaudeMd, '');
  assert.deepEqual(r.docs, []);
});

test('at most 60 docs read', () => {
  const files = { 'CLAUDE.md': '# R' };
  const tracked = [];
  for (let i = 0; i < 70; i++) { files[`p${i}/CLAUDE.md`] = '# x'; tracked.push(`p${i}/CLAUDE.md`); }
  const r = collectMdNetwork({ cwd: CWD, memoryBody: '', trackedFiles: tracked, readFile: fsOf(files) });
  assert.equal(r.docs.length, 60);
});

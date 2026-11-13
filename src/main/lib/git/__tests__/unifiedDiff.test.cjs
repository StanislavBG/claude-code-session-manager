/**
 * unifiedDiff.test.cjs — `parseUnifiedDiff` turns `git diff` unified output
 * into per-file hunks + numbered lines for the Epic Changes view. Hand-written
 * fixtures pin each format case; two cases parse the real output of
 * `git diff --no-color --no-ext-diff -M` from a throwaway repo under
 * os.tmpdir(), so the parser is proven against git's actual format.
 *
 * Run: timeout 120 npx vitest run src/main/lib/git/__tests__/unifiedDiff.test.cjs
 */

'use strict';

import { test, expect, beforeEach, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { parseUnifiedDiff } = require('../unifiedDiff.cjs');

let tmpRoot;
let repoCwd;

function git(args, cwd = repoCwd) {
  return execFileSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'core.quotePath=true', ...args],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
}

function write(rel, content) {
  const abs = path.join(repoCwd, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

function commitAll(msg) {
  git(['add', '-A', '--', '.']);
  git(['commit', '-q', '-m', msg]);
}

function diffHead() {
  git(['add', '-A', '--', '.']);
  return git(['diff', '--no-color', '--no-ext-diff', '-M', '--cached', 'HEAD']);
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'sm-unified-diff-'));
  repoCwd = path.join(tmpRoot, 'repo');
  fs.mkdirSync(repoCwd);
  git(['init', '-q', '-b', 'main']);
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

const numbered = (n, prefix = 'line') => Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`);

test('modified file with 2 hunks carries exact old/new line numbers', () => {
  const text = [
    'diff --git a/src/a.js b/src/a.js',
    'index 1111111..2222222 100644',
    '--- a/src/a.js',
    '+++ b/src/a.js',
    '@@ -1,3 +1,4 @@ function top() {',
    ' one',
    '+inserted',
    ' two',
    ' three',
    '@@ -10,3 +11,2 @@',
    ' ten',
    '-eleven',
    ' twelve',
    '',
  ].join('\n');
  const files = parseUnifiedDiff(text);
  expect(files).toHaveLength(1);
  const f = files[0];
  expect(f).toMatchObject({ path: 'src/a.js', oldPath: null, status: 'modified', binary: false, additions: 1, deletions: 1, truncated: false });
  expect(f.hunks).toHaveLength(2);
  expect(f.hunks[0]).toMatchObject({ header: '@@ -1,3 +1,4 @@ function top() {', oldStart: 1, oldLines: 3, newStart: 1, newLines: 4 });
  expect(f.hunks[0].lines).toEqual([
    { kind: 'ctx', oldNo: 1, newNo: 1, text: 'one' },
    { kind: 'add', oldNo: null, newNo: 2, text: 'inserted' },
    { kind: 'ctx', oldNo: 2, newNo: 3, text: 'two' },
    { kind: 'ctx', oldNo: 3, newNo: 4, text: 'three' },
  ]);
  expect(f.hunks[1]).toMatchObject({ oldStart: 10, oldLines: 3, newStart: 11, newLines: 2 });
  expect(f.hunks[1].lines).toEqual([
    { kind: 'ctx', oldNo: 10, newNo: 11, text: 'ten' },
    { kind: 'del', oldNo: 11, newNo: null, text: 'eleven' },
    { kind: 'ctx', oldNo: 12, newNo: 12, text: 'twelve' },
  ]);
});

test('a deleted line that looks like a ---/+++ header stays inside its hunk', () => {
  const text = [
    'diff --git a/x.md b/x.md',
    '--- a/x.md',
    '+++ b/x.md',
    '@@ -1,2 +1,2 @@',
    '--- a/not-a-header',
    '+++ b/not-a-header',
    ' keep',
  ].join('\n');
  const [f] = parseUnifiedDiff(text);
  expect(f.path).toBe('x.md');
  expect(f.hunks[0].lines.map((l) => [l.kind, l.text])).toEqual([
    ['del', '-- a/not-a-header'],
    ['add', '++ b/not-a-header'],
    ['ctx', 'keep'],
  ]);
});

test('added and deleted files', () => {
  const text = [
    'diff --git a/new.txt b/new.txt',
    'new file mode 100644',
    'index 0000000..3333333',
    '--- /dev/null',
    '+++ b/new.txt',
    '@@ -0,0 +1,2 @@',
    '+hello',
    '+world',
    'diff --git a/old.txt b/old.txt',
    'deleted file mode 100644',
    'index 4444444..0000000',
    '--- a/old.txt',
    '+++ /dev/null',
    '@@ -1 +0,0 @@',
    '-bye',
  ].join('\n');
  const [added, deleted] = parseUnifiedDiff(text);
  expect(added).toMatchObject({ path: 'new.txt', oldPath: null, status: 'added', additions: 2, deletions: 0 });
  expect(added.hunks[0]).toMatchObject({ oldStart: 0, oldLines: 0, newStart: 1, newLines: 2 });
  expect(added.hunks[0].lines[1]).toEqual({ kind: 'add', oldNo: null, newNo: 2, text: 'world' });
  expect(deleted).toMatchObject({ path: 'old.txt', oldPath: null, status: 'deleted', additions: 0, deletions: 1 });
  expect(deleted.hunks[0]).toMatchObject({ oldStart: 1, oldLines: 1, newStart: 0, newLines: 0 });
  expect(deleted.hunks[0].lines).toEqual([{ kind: 'del', oldNo: 1, newNo: null, text: 'bye' }]);
});

test('pure rename and rename with edits', () => {
  const text = [
    'diff --git a/a/old name.js b/b/new.js',
    'similarity index 100%',
    'rename from a/old name.js',
    'rename to b/new.js',
    'diff --git a/lib/x.js b/lib/y.js',
    'similarity index 80%',
    'rename from lib/x.js',
    'rename to lib/y.js',
    'index 5555555..6666666 100644',
    '--- a/lib/x.js',
    '+++ b/lib/y.js',
    '@@ -2 +2 @@',
    '-old',
    '+new',
  ].join('\n');
  const [pure, edited] = parseUnifiedDiff(text);
  expect(pure).toMatchObject({ path: 'b/new.js', oldPath: 'a/old name.js', status: 'renamed', hunks: [], additions: 0, deletions: 0 });
  expect(edited).toMatchObject({ path: 'lib/y.js', oldPath: 'lib/x.js', status: 'renamed', additions: 1, deletions: 1 });
  expect(edited.hunks[0].lines).toEqual([
    { kind: 'del', oldNo: 2, newNo: null, text: 'old' },
    { kind: 'add', oldNo: null, newNo: 2, text: 'new' },
  ]);
});

test('binary files (both forms) and mode-only changes', () => {
  const text = [
    'diff --git a/img.png b/img.png',
    'index 7777777..8888888 100644',
    'Binary files a/img.png and b/img.png differ',
    'diff --git a/blob.bin b/blob.bin',
    'new file mode 100644',
    'index 0000000..9999999',
    'GIT binary patch',
    'literal 4',
    'LcmZQzWMT#Y01f~L',
    '',
    'literal 0',
    'HcmV?d00001',
    '',
    'diff --git a/run.sh b/run.sh',
    'old mode 100644',
    'new mode 100755',
  ].join('\n');
  const [png, blob, sh] = parseUnifiedDiff(text);
  expect(png).toMatchObject({ path: 'img.png', status: 'modified', binary: true, hunks: [], additions: 0, deletions: 0 });
  expect(blob).toMatchObject({ path: 'blob.bin', status: 'added', binary: true, hunks: [] });
  expect(sh).toMatchObject({ path: 'run.sh', oldPath: null, status: 'modified', binary: false, hunks: [] });
});

test('quoted paths (space + non-ASCII) are unquoted, trailing tab stripped', () => {
  const text = [
    'diff --git "a/d\\303\\251j\\303\\240 vu.txt" "b/d\\303\\251j\\303\\240 vu.txt"',
    'index 7898192..422c2b7 100644',
    '--- "a/d\\303\\251j\\303\\240 vu.txt"\t',
    '+++ "b/d\\303\\251j\\303\\240 vu.txt"\t',
    '@@ -1 +1,2 @@',
    ' a',
    '+b',
    'diff --git "a/\\346\\227\\245 x.bin" "b/\\346\\227\\245 x.bin"',
    'Binary files "a/\\346\\227\\245 x.bin" and "b/\\346\\227\\245 x.bin" differ',
  ].join('\n');
  const [txt, bin] = parseUnifiedDiff(text);
  expect(txt.path).toBe('déjà vu.txt');
  expect(txt.hunks[0]).toMatchObject({ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2 });
  expect(bin).toMatchObject({ path: '日 x.bin', binary: true });
});

test('"\\ No newline at end of file" is neither emitted nor counted', () => {
  const text = [
    'diff --git a/nonl b/nonl',
    '--- a/nonl',
    '+++ b/nonl',
    '@@ -1 +1 @@',
    '-x',
    '\\ No newline at end of file',
    '+y',
    '\\ No newline at end of file',
  ].join('\n');
  const [f] = parseUnifiedDiff(text);
  expect(f).toMatchObject({ additions: 1, deletions: 1 });
  expect(f.hunks[0].header).toBe('@@ -1 +1 @@');
  expect(f.hunks[0]).toMatchObject({ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1 });
  expect(f.hunks[0].lines).toEqual([
    { kind: 'del', oldNo: 1, newNo: null, text: 'x' },
    { kind: 'add', oldNo: null, newNo: 1, text: 'y' },
  ]);
});

test('maxLinesPerFile drops lines past the cap but counts every line', () => {
  const body = numbered(10).map((l) => `+${l}`);
  const text = [
    'diff --git a/big b/big',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/big',
    '@@ -0,0 +1,10 @@',
    ...body,
    'diff --git a/small b/small',
    '--- a/small',
    '+++ b/small',
    '@@ -1 +1 @@',
    '-a',
    '+b',
  ].join('\n');
  const [big, small] = parseUnifiedDiff(text, { maxLinesPerFile: 4 });
  expect(big.truncated).toBe(true);
  expect(big.additions).toBe(10);
  expect(big.hunks[0].lines).toHaveLength(4);
  expect(big.hunks[0].lines[3]).toEqual({ kind: 'add', oldNo: null, newNo: 4, text: 'line 4' });
  expect(small).toMatchObject({ truncated: false, additions: 1, deletions: 1 });
  expect(parseUnifiedDiff(text)[0].truncated).toBe(false);
});

test('empty, whitespace-only and non-string input return []', () => {
  expect(parseUnifiedDiff('')).toEqual([]);
  expect(parseUnifiedDiff('  \n\t\n')).toEqual([]);
  expect(parseUnifiedDiff(undefined)).toEqual([]);
  expect(parseUnifiedDiff(null)).toEqual([]);
  expect(parseUnifiedDiff(42)).toEqual([]);
});

test('real git output: modified (2 hunks), added, deleted, renamed-with-edits, mode-only, no-newline', () => {
  write('mod.txt', numbered(30).join('\n') + '\n');
  write('gone.txt', 'bye\nnow\n');
  write('moved/src.txt', numbered(20, 'keep').join('\n') + '\n');
  write('run.sh', 'echo hi\n');
  write('nonl.txt', 'x');
  commitAll('init');

  const mod = numbered(30);
  mod.splice(1, 0, 'NEW after 1');
  mod[25] = 'CHANGED 25';
  write('mod.txt', mod.join('\n') + '\n');
  fs.rmSync(path.join(repoCwd, 'gone.txt'));
  write('fresh.txt', 'hello\n');
  const moved = numbered(20, 'keep');
  moved[19] = 'edited';
  fs.rmSync(path.join(repoCwd, 'moved/src.txt'));
  write('moved/dst.txt', moved.join('\n') + '\n');
  fs.chmodSync(path.join(repoCwd, 'run.sh'), 0o755);
  write('nonl.txt', 'y');

  const files = parseUnifiedDiff(diffHead());
  const byPath = Object.fromEntries(files.map((f) => [f.path, f]));
  expect(Object.keys(byPath).sort()).toEqual(['fresh.txt', 'gone.txt', 'mod.txt', 'moved/dst.txt', 'nonl.txt', 'run.sh']);

  const m = byPath['mod.txt'];
  expect(m).toMatchObject({ status: 'modified', additions: 2, deletions: 1 });
  expect(m.hunks).toHaveLength(2);
  expect(m.hunks[0].lines.find((l) => l.kind === 'add')).toEqual({ kind: 'add', oldNo: null, newNo: 2, text: 'NEW after 1' });
  expect(m.hunks[1].lines.find((l) => l.kind === 'del')).toEqual({ kind: 'del', oldNo: 25, newNo: null, text: 'line 25' });
  expect(m.hunks[1].lines.find((l) => l.kind === 'add')).toEqual({ kind: 'add', oldNo: null, newNo: 26, text: 'CHANGED 25' });

  expect(byPath['fresh.txt']).toMatchObject({ status: 'added', additions: 1, deletions: 0 });
  expect(byPath['gone.txt']).toMatchObject({ status: 'deleted', additions: 0, deletions: 2 });
  expect(byPath['moved/dst.txt']).toMatchObject({ status: 'renamed', oldPath: 'moved/src.txt', additions: 1, deletions: 1 });
  expect(byPath['run.sh']).toMatchObject({ status: 'modified', hunks: [], binary: false });
  expect(byPath['nonl.txt']).toMatchObject({ additions: 1, deletions: 1 });
  expect(byPath['nonl.txt'].hunks[0].lines.map((l) => l.text)).toEqual(['x', 'y']);
});

test('real git output: quoted path with a space and non-ASCII, plus a binary file', () => {
  write('déjà vu.txt', 'a\n');
  write('blob.bin', Buffer.from([0, 1, 2, 3, 0, 255]));
  commitAll('init');
  write('déjà vu.txt', 'a\nb\n');
  write('blob.bin', Buffer.from([0, 9, 9, 9, 0, 255, 7]));

  const raw = diffHead();
  expect(raw).toContain('"a/d\\303\\251j\\303\\240 vu.txt"');
  const files = parseUnifiedDiff(raw);
  const byPath = Object.fromEntries(files.map((f) => [f.path, f]));
  expect(byPath['déjà vu.txt']).toMatchObject({ status: 'modified', additions: 1, deletions: 0, binary: false });
  expect(byPath['déjà vu.txt'].hunks[0].lines[1]).toEqual({ kind: 'add', oldNo: null, newNo: 2, text: 'b' });
  expect(byPath['blob.bin']).toMatchObject({ status: 'modified', binary: true, hunks: [] });
});

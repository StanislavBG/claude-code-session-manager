'use strict';

// Files/Terminal path gate: home OR a main-process-registered project root.
// win32 is injected (fake fs + path.win32) so this runs on any OS.

import { test } from 'vitest';
const assert = require('node:assert/strict');

const { assertInsideHomeOrRoots, checkInsideHomeOrRoots } = require('../lib/insideHome.cjs');
const { isCriticalPath } = require('../files.cjs');

const fakeFs = { realpathSync: Object.assign((p) => p, { native: (p) => p }) };
const HOME = 'C:\\Users\\Me';
const deps = { platform: 'win32', home: HOME, fs: fakeFs };
const ROOTS = ['D:\\code\\proj'];

test('a registered root on another drive is accepted', () => {
  const r = assertInsideHomeOrRoots('D:\\code\\proj\\src', ROOTS, deps);
  assert.equal(r.realPath.toLowerCase(), 'd:\\code\\proj\\src');
  assert.ok(assertInsideHomeOrRoots('d:\\CODE\\Proj', ROOTS, deps));
  assert.ok(assertInsideHomeOrRoots('C:\\Users\\Me\\x', ROOTS, deps));
});

test('an unregistered sibling is refused with path + wording', () => {
  assert.throws(
    () => assertInsideHomeOrRoots('D:\\code\\other', ROOTS, deps),
    /path outside home and project roots: D:\\code\\other/,
  );
  assert.equal(checkInsideHomeOrRoots('E:\\x', [], deps).ok, false);
});

test('prefix trap is refused', () => {
  assert.equal(checkInsideHomeOrRoots('D:\\code\\proj-evil', ROOTS, deps).ok, false);
  assert.equal(checkInsideHomeOrRoots('C:\\Users\\MeEvil', ROOTS, deps).ok, false);
});

test('empty / non-string input is refused', () => {
  assert.equal(checkInsideHomeOrRoots('', ROOTS, deps).ok, false);
  assert.equal(checkInsideHomeOrRoots(undefined, ROOTS, deps).ok, false);
});

test('delete of home itself is refused regardless of case (win32)', () => {
  assert.equal(isCriticalPath('c:\\users\\me', 'win32', HOME), true);
  assert.equal(isCriticalPath('C:\\USERS\\ME\\', 'win32', HOME), true);
  assert.equal(isCriticalPath('C:\\Users\\Me\\proj', 'win32', HOME), false);
});

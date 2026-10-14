'use strict';

import { test } from 'vitest';
const assert = require('node:assert/strict');
const { makeRefResolver } = require('../lib/memoryRefResolve.cjs');

const HOME = '/home/u';
const CWD = '/home/u/proj';
const TRACKED = ['src/renderer/lib/epicIntake.ts', 'README.md'];

function make(existing = []) {
  const calls = [];
  const exists = (p) => { calls.push(p); return existing.includes(p); };
  return { resolve: makeRefResolver({ cwd: CWD, trackedFiles: TRACKED, exists, home: HOME }), calls };
}

test('repo-root hit via exists', () => {
  const { resolve } = make([`${CWD}/docs/a.md`]);
  assert.equal(resolve('docs/a.md'), true);
});

test('exact tracked hit', () => {
  assert.equal(make().resolve('README.md'), true);
});

test('suffix tracked hit', () => {
  assert.equal(make().resolve('lib/epicIntake.ts'), true);
});

test('suffix must align on a path segment', () => {
  assert.equal(make().resolve('ntake.ts'), false);
});

test('sibling root hit with ~ expansion and absolute root', () => {
  const { resolve } = make([`${HOME}/Projects/Bilko/server/routes/stripe.ts`]);
  assert.equal(resolve('server/routes/stripe.ts', ['~/Projects/Bilko']), true);
  assert.equal(resolve('server/routes/stripe.ts', [`${HOME}/Projects/Bilko`]), true);
});

test('root outside home is ignored', () => {
  const { resolve, calls } = make(['/etc/server/x.ts']);
  assert.equal(resolve('server/x.ts', ['/etc']), false);
  assert.equal(calls.includes('/etc/server/x.ts'), false);
});

test("'..', leading / and ~ rejected without calling exists", () => {
  const { resolve, calls } = make(['/etc/passwd']);
  assert.equal(resolve('../x.ts'), false);
  assert.equal(resolve('a/../b.ts'), false);
  assert.equal(resolve('/etc/passwd'), false);
  assert.equal(resolve('~/x.ts'), false);
  assert.deepEqual(calls, []);
});

test('no hit returns false', () => {
  assert.equal(make().resolve('nope/missing.ts', ['~/Projects/Bilko']), false);
});

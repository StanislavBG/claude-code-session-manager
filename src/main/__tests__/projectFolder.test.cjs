/**
 * projectFolder.test.cjs — unit tests for lib/projectFolder.cjs
 * (createProjectFolder + validateProjectName).
 *
 * Run: timeout 300 npx vitest run src/main/__tests__/projectFolder.test.cjs
 */

'use strict';

import { test, expect, beforeEach, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createProjectFolder, validateProjectName } = require('../lib/projectFolder.cjs');

let parent;
beforeEach(() => {
  parent = fs.mkdtempSync(path.join(os.tmpdir(), 'projectFolder-'));
});
afterEach(() => {
  fs.rmSync(parent, { recursive: true, force: true });
});

test('success creates the directory', async () => {
  const r = await createProjectFolder({ parentDir: parent, name: '  my-app  ' });
  expect(r).toEqual({ ok: true, path: path.join(parent, 'my-app') });
  expect(fs.statSync(r.path).isDirectory()).toBe(true);
});

test('unicode, spaces, dots, underscores accepted', async () => {
  for (const name of ['café', 'Ad Scorer 2', 'a.b_c-d']) {
    const r = await createProjectFolder({ parentDir: parent, name });
    expect(r.ok).toBe(true);
    expect(fs.statSync(path.join(parent, name)).isDirectory()).toBe(true);
  }
});

test.each([
  ['empty', ''],
  ['whitespace only', '   '],
  ['too long', 'a'.repeat(101)],
  ['dot', '.'],
  ['dotdot', '..'],
  ['leading dash', '-rf'],
  ['slash', 'a/b'],
  ['backslash', 'a\\b'],
  ['NUL', 'a\u0000b'],
  ['control char', 'a\u001fb'],
  ['DEL', 'a\u007fb'],
  ['non-string', null],
])('rejects invalid name: %s', async (_label, name) => {
  const r = await createProjectFolder({ parentDir: parent, name });
  expect(r.ok).toBe(false);
  expect(r.code).toBe('invalid-name');
  expect(typeof r.error).toBe('string');
  expect(fs.readdirSync(parent)).toEqual([]);
});

test('100-char name is accepted', () => {
  expect(validateProjectName('a'.repeat(100))).toEqual({ ok: true, name: 'a'.repeat(100) });
});

test('non-absolute parentDir rejected', async () => {
  const r = await createProjectFolder({ parentDir: 'relative/dir', name: 'x' });
  expect(r).toMatchObject({ ok: false, code: 'invalid-parent' });
});

test('missing parentDir rejected', async () => {
  const r = await createProjectFolder({ parentDir: path.join(parent, 'nope'), name: 'x' });
  expect(r).toMatchObject({ ok: false, code: 'invalid-parent' });
});

test('parentDir that is a file rejected', async () => {
  const f = path.join(parent, 'file.txt');
  fs.writeFileSync(f, 'x');
  const r = await createProjectFolder({ parentDir: f, name: 'x' });
  expect(r).toMatchObject({ ok: false, code: 'invalid-parent' });
});

test('existing target returns exists with path', async () => {
  fs.mkdirSync(path.join(parent, 'dup'));
  const r = await createProjectFolder({ parentDir: parent, name: 'dup' });
  expect(r).toMatchObject({ ok: false, code: 'exists', path: path.join(parent, 'dup') });
  expect(r.error).toContain('already exists');
});

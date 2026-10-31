/**
 * winPaths.test.cjs — win32 path semantics for insideHome, historyAggregator
 * decodeCwd and agentPersonaSchema absoluteness, with injected platform.
 *
 * Run: timeout 120 npx vitest run src/main/lib/__tests__/winPaths.test.cjs
 */

'use strict';

import { test, expect } from 'vitest';
const { isContained, isContainedIn, realpath } = require('../insideHome.cjs');
const { decodeCwd } = require('../../historyAggregator.cjs');
const { isAbsoluteForPlatform } = require('../persona-macro/agentPersonaSchema.cjs');
const { encodeCwd } = require('../util/encodeCwd.cjs');

test('insideHome win32: case-insensitive containment', () => {
  expect(isContained('C:\\Users\\Me\\proj', 'c:\\users\\me', 'win32')).toBe(true);
  expect(isContained('c:\\USERS\\me', 'C:\\Users\\Me', 'win32')).toBe(true);
  expect(isContained('C:\\Users\\Me\\', 'C:\\Users\\Me', 'win32')).toBe(true);
  expect(isContained('C:/Users/Me/proj', 'C:\\Users\\Me', 'win32')).toBe(true);
});

test('insideHome win32: prefix trap, other drive, UNC, \\\\?\\ are outside', () => {
  expect(isContained('C:\\Users\\Mean', 'C:\\Users\\Me', 'win32')).toBe(false);
  expect(isContained('D:\\Users\\Me\\proj', 'C:\\Users\\Me', 'win32')).toBe(false);
  expect(isContained('\\\\server\\share\\Users\\Me', 'C:\\Users\\Me', 'win32')).toBe(false);
  expect(isContained('\\\\?\\C:\\Users\\Me\\proj', 'C:\\Users\\Me', 'win32')).toBe(false);
  expect(isContained('C:\\Users\\Me\\..\\Other', 'C:\\Users\\Me', 'win32')).toBe(false);
});

test('insideHome posix: unchanged, case-sensitive', () => {
  expect(isContained('/home/bilko/x', '/home/bilko', 'linux')).toBe(true);
  expect(isContained('/home/bilko', '/home/bilko', 'linux')).toBe(true);
  expect(isContained('/home/bilkoEVIL', '/home/bilko', 'linux')).toBe(false);
  expect(isContained('/HOME/bilko/x', '/home/bilko', 'linux')).toBe(false);
});

test('decodeCwd win32 reverses encodeCwd for a Windows path', () => {
  expect(encodeCwd('C:\\Users\\Me\\proj')).toBe('C--Users-Me-proj');
  expect(decodeCwd('C--Users-Me-proj', 'win32')).toBe('C:\\Users\\Me\\proj');
});

test('decodeCwd posix unchanged', () => {
  expect(decodeCwd('home-bilko-proj', 'linux')).toBe('/home/bilko/proj');
  expect(decodeCwd('Users-me-proj', 'darwin')).toBe('/Users/me/proj');
});

test('agentPersona absoluteness is platform-aware', () => {
  expect(isAbsoluteForPlatform('C:\\Users\\Me\\proj', 'win32')).toBe(true);
  expect(isAbsoluteForPlatform('rel\\dir', 'win32')).toBe(false);
  expect(isAbsoluteForPlatform('/home/me', 'linux')).toBe(true);
  expect(isAbsoluteForPlatform('C:\\Users\\Me', 'linux')).toBe(false);
  expect(isAbsoluteForPlatform('rel/dir', 'linux')).toBe(false);
});

test('isContainedIn win32: drive-root root', () => {
  expect(isContainedIn('D:\\proj\\x', 'D:\\', 'win32')).toBe(true);
  expect(isContainedIn('d:\\', 'D:\\', 'win32')).toBe(true);
  expect(isContainedIn('C:\\proj', 'D:\\', 'win32')).toBe(false);
});

test('isContainedIn win32: UNC home matches itself and children only', () => {
  const home = '\\\\srv\\share\\me';
  expect(isContainedIn('\\\\SRV\\share\\me', home, 'win32')).toBe(true);
  expect(isContainedIn('\\\\srv\\share\\me\\proj', home, 'win32')).toBe(true);
  expect(isContainedIn('\\\\srv\\share\\mean', home, 'win32')).toBe(false);
  expect(isContainedIn('\\\\other\\share\\me', home, 'win32')).toBe(false);
  expect(isContainedIn('\\\\?\\C:\\x', home, 'win32')).toBe(false);
  expect(isContainedIn('C:\\srv\\share\\me', home, 'win32')).toBe(false);
});

test('realpath: native used, 8.3 expanded via injected fs', () => {
  const native = (p) => p.replace('JOHNSM~1', 'johnsmith');
  const fakeFs = { realpathSync: Object.assign(() => { throw new Error('js used'); }, { native }) };
  const real = realpath('C:\\Users\\JOHNSM~1\\proj', { fs: fakeFs, platform: 'win32' });
  expect(real).toBe('C:\\Users\\johnsmith\\proj');
  expect(isContainedIn(real, 'C:\\Users\\johnsmith', 'win32')).toBe(true);
});

test('realpath: falls back to fs.realpathSync without native', () => {
  const fakeFs = { realpathSync: (p) => p + '-js' };
  // Drive-qualified win32 path: realpath() resolves with path.win32 for 'win32' on every host,
  // whereas platform:'linux' resolves with the HOST's path module (D:\ prefix on a Windows runner).
  expect(realpath('C:\\a\\b', { fs: fakeFs, platform: 'win32' })).toBe('C:\\a\\b-js');
});

test('realpath: ENOENT walks to nearest existing parent', () => {
  const enoent = () => Object.assign(new Error('x'), { code: 'ENOENT' });
  const native = (p) => {
    if (p === 'C:\\Users\\JOHNSM~1') return 'C:\\Users\\johnsmith';
    throw enoent();
  };
  const fakeFs = { realpathSync: Object.assign(native, { native }) };
  expect(realpath('C:\\Users\\JOHNSM~1\\a\\b\\c.json', { fs: fakeFs, platform: 'win32' }))
    .toBe('C:\\Users\\johnsmith\\a\\b\\c.json');
});

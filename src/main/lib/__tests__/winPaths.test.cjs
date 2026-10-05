/**
 * winPaths.test.cjs — win32 path semantics for insideHome, historyAggregator
 * decodeCwd and agentPersonaSchema absoluteness, with injected platform.
 *
 * Run: timeout 120 npx vitest run src/main/lib/__tests__/winPaths.test.cjs
 */

'use strict';

import { test, expect } from 'vitest';
const { isContained } = require('../insideHome.cjs');
const { decodeCwd } = require('../../historyAggregator.cjs');
const { isAbsoluteForPlatform } = require('../agentPersonaSchema.cjs');
const { encodeCwd } = require('../encodeCwd.cjs');

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

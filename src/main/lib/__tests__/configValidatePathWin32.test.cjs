/**
 * configValidatePathWin32.test.cjs — config.validatePath uses insideHome's
 * comparator, so win32 casing/drive-root/sibling-prefix rules apply.
 * Platform and realpath are injected (process.platform + fs.realpathSync.native).
 *
 * Run: timeout 120 npx vitest run src/main/lib/__tests__/configValidatePathWin32.test.cjs
 */

'use strict';

import { test, expect, vi, beforeEach, afterEach } from 'vitest';
const fs = require('node:fs');
const config = require('../../config.cjs');

const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
let nativeSpy;

beforeEach(() => {
  Object.defineProperty(process, 'platform', { value: 'win32' });
  // Everything "exists" and is already canonical.
  nativeSpy = vi.spyOn(fs.realpathSync, 'native').mockImplementation((p) => p);
});

afterEach(() => {
  nativeSpy.mockRestore();
  Object.defineProperty(process, 'platform', realPlatform);
});

test('lower-case drive cwd is accepted against an upper-case registered root', () => {
  config.addAllowedRoot('D:\\Work\\Proj');
  expect(() => config.validatePath('d:\\work\\proj\\src\\a.ts')).not.toThrow();
});

test('drive-root allowed root accepts children', () => {
  config.addAllowedRoot('E:\\');
  expect(() => config.validatePath('e:\\anything\\x')).not.toThrow();
});

test('sibling-prefix trap is rejected', () => {
  config.addAllowedRoot('F:\\Work\\Proj');
  expect(() => config.validatePath('F:\\Work\\ProjEVIL\\x')).toThrow(/outside allowed/);
});

/**
 * appRuntime.test.cjs — unit tests for the packaged-vs-dev node command helper.
 *
 * Run: timeout 120 npx vitest run src/main/lib/__tests__/appRuntime.test.cjs
 */

'use strict';

import { test, expect, afterEach } from 'vitest';
const { isPackagedApp, nodeSpawnSpec, nodeShellCommand } = require('../appRuntime.cjs');

const EXEC = '/Applications/Session Manager.app/Contents/MacOS/Session Manager';
const SCRIPT = 'C:\\Users\\First Last\\hooks\\guard.cjs';

afterEach(() => {
  delete process.env.SM_FORCE_PACKAGED;
});

test('isPackagedApp is false under plain node and honours overrides', () => {
  expect(isPackagedApp()).toBe(false);
  expect(isPackagedApp({ packaged: true })).toBe(true);
  expect(isPackagedApp({ packaged: false })).toBe(false);
  process.env.SM_FORCE_PACKAGED = '1';
  expect(isPackagedApp()).toBe(true);
  expect(isPackagedApp({ packaged: false })).toBe(false);
});

test('nodeSpawnSpec: dev mode uses node', () => {
  expect(nodeSpawnSpec('/a b/s.cjs', { packaged: false })).toEqual({
    command: 'node',
    args: ['/a b/s.cjs'],
    env: {},
  });
});

test('nodeSpawnSpec: packaged mode uses the app binary with ELECTRON_RUN_AS_NODE', () => {
  expect(nodeSpawnSpec(SCRIPT, { packaged: true, execPath: EXEC })).toEqual({
    command: EXEC,
    args: [SCRIPT],
    env: { ELECTRON_RUN_AS_NODE: '1' },
  });
  expect(nodeSpawnSpec(SCRIPT, { packaged: true }).command).toBe(process.execPath);
});

test('nodeShellCommand: dev mode quotes the script path', () => {
  expect(nodeShellCommand('/home/First Last/s.cjs', { packaged: false })).toBe(
    'node "/home/First Last/s.cjs"',
  );
});

test('nodeShellCommand: packaged mode quotes execPath and script', () => {
  expect(nodeShellCommand(SCRIPT, { packaged: true, execPath: EXEC })).toBe(
    `ELECTRON_RUN_AS_NODE=1 "${EXEC}" "${SCRIPT}"`,
  );
});

test('nodeShellCommand rejects embedded double quotes', () => {
  expect(() => nodeShellCommand('/a/"b".cjs', { packaged: false })).toThrow(Error);
  expect(() => nodeShellCommand('/a/s.cjs', { packaged: true, execPath: '/x/"y"' })).toThrow(Error);
});

/**
 * killTree.test.cjs — POSIX group kill, ESRCH/EPERM fallback, win32 taskkill
 * argv, and detachedSpawnOpts per platform.
 *
 * Run: timeout 120 npx vitest run src/main/lib/__tests__/killTree.test.cjs
 */

'use strict';

import { test, expect } from 'vitest';
const { killTree, detachedSpawnOpts } = require('../killTree.cjs');

const err = (code) => Object.assign(new Error(code), { code });

test('POSIX: signals the process group (-pid)', () => {
  const calls = [];
  const ok = killTree(1234, 'SIGTERM', { platform: 'linux', kill: (p, s) => { calls.push([p, s]); } });
  expect(ok).toBe(true);
  expect(calls).toEqual([[-1234, 'SIGTERM']]);
});

test('POSIX: ESRCH on group falls back to the bare pid', () => {
  const calls = [];
  const kill = (p, s) => { calls.push([p, s]); if (p < 0) throw err('ESRCH'); };
  expect(killTree(1234, 'SIGKILL', { platform: 'linux', kill })).toBe(true);
  expect(calls).toEqual([[-1234, 'SIGKILL'], [1234, 'SIGKILL']]);
});

test('POSIX: EPERM on group falls back to the bare pid', () => {
  const calls = [];
  const kill = (p, s) => { calls.push([p, s]); if (p < 0) throw err('EPERM'); };
  expect(killTree(77, 'SIGTERM', { platform: 'darwin', kill })).toBe(true);
  expect(calls).toEqual([[-77, 'SIGTERM'], [77, 'SIGTERM']]);
});

test('POSIX: returns false and never throws when both kills fail', () => {
  const kill = () => { throw err('ESRCH'); };
  expect(killTree(1234, 'SIGTERM', { platform: 'linux', kill })).toBe(false);
});

test('POSIX: unexpected group-kill error returns false without fallback', () => {
  const calls = [];
  const kill = (p) => { calls.push(p); throw err('EINVAL'); };
  expect(killTree(1234, 'NOPE', { platform: 'linux', kill })).toBe(false);
  expect(calls).toEqual([-1234]);
});

test('invalid pid returns false without signalling', () => {
  const kill = () => { throw new Error('should not be called'); };
  expect(killTree(0, 'SIGTERM', { platform: 'linux', kill })).toBe(false);
  expect(killTree(NaN, 'SIGTERM', { platform: 'linux', kill })).toBe(false);
});

test('win32: runs taskkill /PID <pid> /T /F with windowsHide, no shell, any signal', () => {
  const calls = [];
  const execFile = (file, args, options, cb) => { calls.push({ file, args, options }); cb(null); };
  const kill = () => { throw new Error('process.kill must not be used on win32'); };
  expect(killTree(4321, 'SIGTERM', { platform: 'win32', execFile, kill })).toBe(true);
  expect(killTree(4321, 'SIGKILL', { platform: 'win32', execFile, kill })).toBe(true);
  expect(calls).toHaveLength(2);
  for (const c of calls) {
    expect(c.file).toBe('taskkill');
    expect(c.args).toEqual(['/PID', '4321', '/T', '/F']);
    expect(c.options).toEqual({ windowsHide: true });
    expect(c.options.shell).toBeUndefined();
  }
});

test('win32: taskkill failure is logged, not thrown', () => {
  const logs = [];
  const execFile = (_f, _a, _o, cb) => cb(err('1'));
  expect(killTree(9, 'SIGTERM', { platform: 'win32', execFile, log: (m) => logs.push(m) })).toBe(true);
  expect(logs).toHaveLength(1);
  expect(logs[0]).toContain('taskkill /PID 9 failed');
});

test('win32: synchronous execFile throw returns false', () => {
  const execFile = () => { throw new Error('ENOENT'); };
  expect(killTree(9, 'SIGTERM', { platform: 'win32', execFile })).toBe(false);
});

test('detachedSpawnOpts per platform', () => {
  expect(detachedSpawnOpts({ platform: 'linux' })).toEqual({ detached: true });
  expect(detachedSpawnOpts({ platform: 'darwin' })).toEqual({ detached: true });
  expect(detachedSpawnOpts({ platform: 'win32' })).toEqual({ detached: true, windowsHide: true });
});

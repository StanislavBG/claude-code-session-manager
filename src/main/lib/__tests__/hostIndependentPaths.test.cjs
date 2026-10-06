// Host-independence: with a platform injected, behaviour must not depend on the
// host `path` flavour. Simulate a Windows host by pointing the shared `path`
// module's functions at path.win32 while a 'linux' platform is injected.
const path = require('node:path');
import { test, expect, afterEach } from 'vitest';
const { resolveClaudeBin } = require('../claudeBin.cjs');
const { userBinDirs, pathWithUserBins } = require('../cleanEnv.cjs');
const { isContained } = require('../insideHome.cjs');

// normalize/relative are left alone: path.posix.join calls the shared normalize internally.
const KEYS = ['join', 'resolve', 'sep', 'delimiter'];
const saved = {};
for (const k of KEYS) saved[k] = path[k];
const realPosix = path.posix;
const posixCopy = { ...path.posix };

// On a POSIX host `path === path.posix`, so mutating the bare functions would
// corrupt path.posix too; give path.posix its own copy first.
function stubWinHost() {
  Object.defineProperty(path, 'posix', { value: posixCopy, configurable: true, writable: true });
  for (const k of KEYS) path[k] = path.win32[k];
}
afterEach(() => {
  for (const k of KEYS) path[k] = saved[k];
  Object.defineProperty(path, 'posix', { value: realPosix, configurable: true, writable: true });
});

test('resolveClaudeBin posix candidates use POSIX joins on a win32 host', () => {
  stubWinHost();
  const seen = [];
  resolveClaudeBin({
    platform: 'linux', homedir: '/h', env: {},
    accessSync: (p) => { seen.push(p); throw new Error('no'); },
  });
  expect(seen[0]).toBe('/h/.claude/local/claude');
  expect(seen[1]).toBe('/h/.local/bin/claude');
});

test('resolveClaudeBin win32 candidates use win32 joins on a posix host', () => {
  const seen = [];
  resolveClaudeBin({
    platform: 'win32', env: { USERPROFILE: 'C:\\Users\\Me' },
    accessSync: (p) => { seen.push(p); throw new Error('no'); },
  });
  expect(seen[0]).toBe('C:\\Users\\Me\\.local\\bin\\claude.exe');
});

test('cleanEnv userBinDirs/pathWithUserBins honour injected platform', () => {
  stubWinHost();
  expect(userBinDirs({ platform: 'linux', homedir: '/h' })[0]).toBe('/h/.claude/local');
  expect(pathWithUserBins({ platform: 'linux', homedir: '/h', env: { PATH: '/a' } })).toMatch(/^\/a:\/h\/\.claude\/local:/);
  expect(pathWithUserBins({ platform: 'win32', env: { PATH: 'C:\\a', USERPROFILE: 'C:\\U' } }))
    .toBe('C:\\a;C:\\U\\.local\\bin');
});

test('isContained linux answer is POSIX on a win32 host', () => {
  stubWinHost();
  expect(isContained('/home/bilko/x', '/home/bilko', 'linux')).toBe(true);
  expect(isContained('/home/bilkoEVIL', '/home/bilko', 'linux')).toBe(false);
});

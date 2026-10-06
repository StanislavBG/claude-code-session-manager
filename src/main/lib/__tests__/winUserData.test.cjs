import { createRequire } from 'node:module';
import { test, expect } from 'vitest';

const require = createRequire(import.meta.url);
const { ensureWinUserDataPath } = require('../winUserData.cjs');

function mk(throws) {
  const setPath = [];
  const mkdir = [];
  const logs = [];
  return {
    setPath, mkdir, logs,
    deps: {
      app: { getPath() { if (throws) throw new Error("Failed to get 'userData' path"); return 'x'; }, setPath: (k, v) => setPath.push([k, v]) },
      env: { APPDATA: 'C:\\Users\\r\\AppData\\Roaming' },
      platform: 'win32',
      fs: { mkdirSync: (p, o) => mkdir.push([p, o]) },
      os: { homedir: () => 'C:\\Users\\h' },
      log: (m) => logs.push(m),
    },
  };
}

test('getPath ok: no change', () => {
  const m = mk(false);
  expect(ensureWinUserDataPath(m.deps)).toBe(false);
  expect(m.setPath).toEqual([]);
});

test('getPath throws on win32: sets APPDATA-based paths', () => {
  const m = mk(true);
  expect(ensureWinUserDataPath(m.deps)).toBe(true);
  expect(m.setPath).toEqual([
    ['appData', 'C:\\Users\\r\\AppData\\Roaming'],
    ['userData', 'C:\\Users\\r\\AppData\\Roaming\\Session Manager'],
  ]);
  expect(m.mkdir[0][0]).toBe('C:\\Users\\r\\AppData\\Roaming\\Session Manager');
  expect(m.logs).toHaveLength(1);
});

test('getPath throws, no APPDATA: falls back to homedir', () => {
  const m = mk(true);
  m.deps.env = {};
  ensureWinUserDataPath(m.deps);
  expect(m.setPath[1][1]).toBe('C:\\Users\\h\\AppData\\Roaming\\Session Manager');
});

test('non-win32: no-op', () => {
  const m = mk(true);
  m.deps.platform = 'linux';
  expect(ensureWinUserDataPath(m.deps)).toBe(false);
  expect(m.setPath).toEqual([]);
});

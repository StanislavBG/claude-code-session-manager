import path from 'node:path';
import { createRequire } from 'node:module';
import { test, expect } from 'vitest';

// Under plain Node `require('electron')` yields the binary path string, so the
// module's destructured electron bindings are undefined; every dep is injected.
const require = createRequire(import.meta.url);
const { startCrashReporter } = require('../crashDiagnostics.cjs');

function mk(paths, mkdirImpl = () => {}) {
  const calls = { start: 0, setPath: [], mkdir: [], log: [] };
  return {
    calls,
    deps: {
      app: { getPath: (n) => paths[n], setPath: (n, v) => calls.setPath.push([n, v]) },
      crashReporter: { start: () => { calls.start += 1; } },
      fs: { mkdirSync: (d, o) => { calls.mkdir.push([d, o]); mkdirImpl(d); } },
      log: (m) => calls.log.push(m),
    },
  };
}

test('crashDumps present: mkdir, start, no setPath', () => {
  const { calls, deps } = mk({ crashDumps: '/cd', userData: '/ud' });
  startCrashReporter(deps);
  expect(calls.mkdir).toEqual([['/cd', { recursive: true }]]);
  expect(calls.setPath).toEqual([]);
  expect(calls.start).toBe(1);
});

test('crashDumps empty: falls back to userData/Crashpad and setPath', () => {
  const { calls, deps } = mk({ crashDumps: '', userData: '/ud' });
  startCrashReporter(deps);
  const dir = path.join('/ud', 'Crashpad');
  expect(calls.mkdir[0][0]).toBe(dir);
  expect(calls.setPath).toEqual([['crashDumps', dir]]);
  expect(calls.start).toBe(1);
});

test('userData empty too: start skipped, one log line', () => {
  const { calls, deps } = mk({ crashDumps: '', userData: '' });
  startCrashReporter(deps);
  expect(calls.start).toBe(0);
  expect(calls.mkdir).toEqual([]);
  expect(calls.log).toHaveLength(1);
});

test('mkdir throws: start skipped, no throw', () => {
  const { calls, deps } = mk({ crashDumps: '/cd' }, () => { throw new Error('EACCES'); });
  expect(() => startCrashReporter(deps)).not.toThrow();
  expect(calls.start).toBe(0);
  expect(calls.log).toHaveLength(1);
});

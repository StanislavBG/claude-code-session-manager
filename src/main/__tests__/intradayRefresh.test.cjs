import { test, expect, vi } from 'vitest';
const { createIntradayRefresh } = require('../lib/intradayRefresh.cjs');

const mk = (over = {}) => {
  const logs = { writeLine: vi.fn() };
  const releaseLock = vi.fn();
  const deps = { tryAcquireLock: vi.fn(() => true), releaseLock, lockPath: '/x.lock', refresh: vi.fn(async () => {}), logs, ...over };
  return { deps, run: createIntradayRefresh(deps), logs, releaseLock };
};
const flush = () => new Promise((r) => setTimeout(r, 0));

test('sync throw from refresh releases the lock and logs', async () => {
  const { run, logs, releaseLock } = mk({ refresh: () => { throw new Error('boom'); } });
  expect(() => run()).not.toThrow();
  await flush();
  expect(releaseLock).toHaveBeenCalledWith('/x.lock');
  expect(logs.writeLine).toHaveBeenCalled();
});

test('async rejection releases the lock', async () => {
  const { run, releaseLock } = mk({ refresh: async () => { throw new Error('x'); } });
  run(); await flush();
  expect(releaseLock).toHaveBeenCalledTimes(1);
});

test('lock-acquire throw is logged, not escaped, and no release', async () => {
  const { run, logs, releaseLock, deps } = mk({ tryAcquireLock: () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); } });
  expect(() => run()).not.toThrow();
  expect(logs.writeLine).toHaveBeenCalledTimes(1);
  expect(releaseLock).not.toHaveBeenCalled();
  expect(deps.refresh).not.toHaveBeenCalled();
});

test('contended lock skips refresh', () => {
  const { run, deps, releaseLock } = mk({ tryAcquireLock: () => false });
  run();
  expect(deps.refresh).not.toHaveBeenCalled();
  expect(releaseLock).not.toHaveBeenCalled();
});

'use strict';

import { test, expect, vi } from 'vitest';
const scheduler = require('../scheduler.cjs');

const jobSpawn = { command: 'claude', args: ['-p', '--model', 'x'], argv0: 'sm-claude-job' };
const limits = { memoryMaxMb: 1000, memoryHighMb: 850, swapMaxMb: 4096 };

test('wraps in a memory scope when supported and limits allow', () => {
  const plan = scheduler.planJobScope({
    jobSpawn, slug: '12-my slug', startedAt: 1700,
    deps: { scopeSupported: () => true, memoryLimitsFor: () => limits },
  });
  expect(plan.unit).toBe('sm-job-12-my-slug-1700');
  expect(plan.spawn.command).toBe('systemd-run');
  expect(plan.spawn.args).toContain('--unit=sm-job-12-my-slug-1700.scope');
  expect(plan.spawn.args).toContain('MemoryMax=1000M');
  expect(plan.spawn.args.slice(plan.spawn.args.indexOf('--') + 1)).toEqual(['claude', '-p', '--model', 'x']);
  expect(plan.spawn.argv0).toBeUndefined();
});

test('falls back to the untouched spawn target when unsupported or disabled', () => {
  const a = scheduler.planJobScope({ jobSpawn, slug: 's', startedAt: 1, deps: { scopeSupported: () => false } });
  expect(a.spawn).toBe(jobSpawn);
  expect(a.unit).toBeNull();
  const b = scheduler.planJobScope({ jobSpawn, slug: 's', startedAt: 1, deps: { scopeSupported: () => true, memoryLimitsFor: () => null } });
  expect(b.spawn).toBe(jobSpawn);
  expect(b.unit).toBeNull();
});

test('finalize logs peak + oom_kill and stops the scope exactly once', () => {
  const files = {
    '/cg/memory.peak': '2097152\n',
    '/cg/memory.events': 'low 0\nhigh 3\nmax 1\noom 1\noom_kill 2\n',
  };
  const fsImpl = { readFileSync: (p) => { if (p in files) return files[p]; throw new Error('ENOENT'); } };
  const stopScope = vi.fn();
  const log = vi.fn();
  const state = { unit: 'u1', pid: 1, cgroupDir: '/cg', finalized: false };
  scheduler.finalizeJobScope(state, log, { fs: fsImpl, stopScope });
  scheduler.finalizeJobScope(state, log, { fs: fsImpl, stopScope });
  expect(stopScope).toHaveBeenCalledTimes(1);
  expect(stopScope).toHaveBeenCalledWith('u1');
  expect(log.mock.calls[0][0]).toContain('peak=2MB oom_kill=2');
});

test('missing cgroup files are ignored and unwrapped state never stops anything', () => {
  const stopScope = vi.fn();
  const log = vi.fn();
  const fsImpl = { readFileSync: () => { throw new Error('ENOENT'); } };
  scheduler.finalizeJobScope({ unit: 'u2', pid: null, cgroupDir: '/gone', finalized: false }, log, { fs: fsImpl, stopScope });
  expect(log).not.toHaveBeenCalled();
  expect(stopScope).toHaveBeenCalledWith('u2');
  scheduler.finalizeJobScope({ unit: null, finalized: false }, log, { fs: fsImpl, stopScope });
  expect(stopScope).toHaveBeenCalledTimes(1);
});

test('null limits: scopeSupported is not called and the spawn is unwrapped', () => {
  const scopeSupported = vi.fn(() => true);
  const plan = scheduler.planJobScope({ jobSpawn, slug: 's', startedAt: 1, deps: { scopeSupported, memoryLimitsFor: () => null } });
  expect(scopeSupported).not.toHaveBeenCalled();
  expect(plan.spawn).toBe(jobSpawn);
  expect(plan.unit).toBeNull();
});

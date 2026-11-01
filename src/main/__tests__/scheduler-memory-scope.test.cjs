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

test('sampleJobScope keeps last good values after files vanish; finalize logs them', () => {
  const files = { '/cg/memory.peak': '5242880\n', '/cg/memory.events': 'oom_kill 1\n' };
  const fsImpl = { readFileSync: (p) => { if (p in files) return files[p]; throw new Error('ENOENT'); } };
  const state = { unit: 'u3', pid: null, cgroupDir: '/cg', finalized: false };
  scheduler.sampleJobScope(state, fsImpl);
  expect(state.peak).toBe(5242880);
  expect(state.oomKills).toBe(1);
  for (const k of Object.keys(files)) delete files[k];
  scheduler.sampleJobScope(state, fsImpl);
  expect(state.peak).toBe(5242880);
  const log = vi.fn();
  const stopScope = vi.fn();
  scheduler.finalizeJobScope(state, log, { fs: fsImpl, stopScope });
  expect(log.mock.calls[0][0]).toContain('memory scope u3: peak=5MB oom_kill=1');
});

test('no sample ever taken logs nothing', () => {
  const log = vi.fn();
  const fsImpl = { readFileSync: () => { throw new Error('ENOENT'); } };
  scheduler.finalizeJobScope({ unit: 'u4', pid: null, cgroupDir: null, finalized: false }, log, { fs: fsImpl, stopScope: vi.fn() });
  expect(log).not.toHaveBeenCalled();
});

test('finalize clears the sampling interval', () => {
  const clear = vi.spyOn(globalThis, 'clearInterval');
  const timer = setInterval(() => {}, 100000);
  timer.unref();
  const state = { unit: 'u5', pid: null, cgroupDir: null, finalized: false, sampler: timer };
  scheduler.finalizeJobScope(state, vi.fn(), { fs: { readFileSync: () => { throw new Error('x'); } }, stopScope: vi.fn() });
  expect(clear).toHaveBeenCalledWith(timer);
  expect(state.sampler).toBeNull();
  clear.mockRestore();
});

const memoryScope = require('../lib/process/memoryScope.cjs');
const realTest = memoryScope.scopeSupported() ? test : test.skip;
realTest('real scope: sampling a running sleep gives peak > 0 and no oom kills', async () => {
  const { spawn } = require('node:child_process');
  const unit = `sm-job-test-${process.pid}-${Date.now()}`;
  const w = memoryScope.wrapInMemoryScope({
    command: 'sleep', args: ['2'], unit,
    limits: { memoryMaxMb: 512, memoryHighMb: 400, swapMaxMb: 0 },
  });
  const child = spawn(w.command, w.args, { stdio: 'ignore' });
  try {
    let dir = null;
    const deadline = Date.now() + 1000;
    while (!dir && Date.now() < deadline) {
      dir = scheduler.readJobCgroupDir(child.pid, unit);
      if (!dir) await new Promise((r) => setTimeout(r, 50));
    }
    expect(dir).not.toBeNull();
    const state = { cgroupDir: dir };
    scheduler.sampleJobScope(state);
    expect(state.peak).toBeGreaterThan(0);
    expect(state.oomKills).toBe(0);
  } finally {
    child.kill();
    memoryScope.stopScope(unit);
  }
}, 10000);

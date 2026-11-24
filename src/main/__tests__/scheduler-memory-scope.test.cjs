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

test('default plan uses the scheduler job caps (6G soft, 10G hard) and records the cap', () => {
  // tests/setup/schedulerSandbox.cjs disables scopes with SM_JOB_MEMORY_MAX_MB=0.
  const saved = process.env.SM_JOB_MEMORY_MAX_MB;
  delete process.env.SM_JOB_MEMORY_MAX_MB;
  try {
    const plan = scheduler.planJobScope({ jobSpawn, slug: 's', startedAt: 1, deps: { scopeSupported: () => true } });
    expect(plan.spawn.args).toContain('MemoryHigh=6G');
    expect(plan.spawn.args).toContain('MemoryMax=10G');
    expect(plan.memoryMaxMb).toBe(10240);
  } finally {
    process.env.SM_JOB_MEMORY_MAX_MB = saved;
  }
});

test('unsupported systemd-run: the job starts unscoped with the default caps', () => {
  const saved = process.env.SM_JOB_MEMORY_MAX_MB;
  delete process.env.SM_JOB_MEMORY_MAX_MB;
  try {
    const plan = scheduler.planJobScope({ jobSpawn, slug: 's', startedAt: 1, deps: { scopeSupported: () => false } });
    expect(plan.spawn).toBe(jobSpawn);
    expect(plan.unit).toBeNull();
    expect(plan.memoryMaxMb).toBeNull();
  } finally {
    process.env.SM_JOB_MEMORY_MAX_MB = saved;
  }
});

test('memoryCapFailureReason names the cap only for an oom-killed failed run', () => {
  const state = { unit: 'u', oomKills: 1, memoryMaxMb: 10240 };
  expect(scheduler.memoryCapFailureReason(state, 137)).toBe('job hit its 10 GB memory cap (oom_kill=1)');
  expect(scheduler.memoryCapFailureReason(state, null)).toBe('job hit its 10 GB memory cap (oom_kill=1)');
  expect(scheduler.memoryCapFailureReason(state, 0)).toBeNull();
  expect(scheduler.memoryCapFailureReason({ ...state, oomKills: 0 }, 137)).toBeNull();
  expect(scheduler.memoryCapFailureReason({ unit: 'u' }, 137)).toBeNull();
  expect(scheduler.memoryCapFailureReason(null, 137)).toBeNull();
  expect(scheduler.memoryCapFailureReason({ unit: 'u', oomKills: 2 }, 1)).toBe('job hit its memory cap (oom_kill=2)');
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

test('finalize records the peak with the job agentType through recordPeak', () => {
  const fsImpl = { readFileSync: (p) => { if (p === '/cg/memory.peak') return String(1500 * 1048576); throw new Error('ENOENT'); } };
  const recordPeak = vi.fn();
  scheduler.finalizeJobScope({ unit: 'u6', pid: null, cgroupDir: '/cg', finalized: false, agentType: 'validator' }, vi.fn(), { fs: fsImpl, stopScope: vi.fn(), recordPeak });
  expect(recordPeak).toHaveBeenCalledTimes(1);
  expect(recordPeak).toHaveBeenCalledWith({ agentType: 'validator', peakMb: 1500, unit: 'u6' });
});

test('finalize defaults the agentType to dev-lead and records nothing without a peak', () => {
  const recordPeak = vi.fn();
  const peakFs = { readFileSync: (p) => { if (p === '/cg/memory.peak') return String(700 * 1048576); throw new Error('ENOENT'); } };
  scheduler.finalizeJobScope({ unit: 'u7', pid: null, cgroupDir: '/cg', finalized: false }, vi.fn(), { fs: peakFs, stopScope: vi.fn(), recordPeak });
  expect(recordPeak).toHaveBeenCalledWith({ agentType: 'dev-lead', peakMb: 700, unit: 'u7' });
  recordPeak.mockClear();
  const noFs = { readFileSync: () => { throw new Error('ENOENT'); } };
  scheduler.finalizeJobScope({ unit: 'u8', pid: null, cgroupDir: '/cg', finalized: false }, vi.fn(), { fs: noFs, stopScope: vi.fn(), recordPeak });
  expect(recordPeak).not.toHaveBeenCalled();
});

test('a throwing recordPeak never skips stopping the scope', () => {
  const stopScope = vi.fn();
  const fsImpl = { readFileSync: (p) => { if (p === '/cg/memory.peak') return '1048576'; throw new Error('ENOENT'); } };
  scheduler.finalizeJobScope({ unit: 'u9', pid: null, cgroupDir: '/cg', finalized: false }, vi.fn(), { fs: fsImpl, stopScope, recordPeak: () => { throw new Error('disk'); } });
  expect(stopScope).toHaveBeenCalledWith('u9');
});

test('memory backfill passes the runs folder itself, bounded', async () => {
  const backfillFromRunLogs = vi.fn(async () => 3);
  expect(await scheduler.backfillMemoryStats({ runsDir: '/runs', backfillFromRunLogs })).toBe(3);
  expect(backfillFromRunLogs).toHaveBeenCalledTimes(1);
  const [dir, opts] = backfillFromRunLogs.mock.calls[0];
  expect(dir).toBe('/runs');
  expect(opts.maxFiles).toBe(500);
});

test('memory backfill end to end: seeds the store from a run log peak line', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { createJobMemoryStats, STORE_FILE } = require('../lib/scheduler/jobMemoryStats.cjs');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'memfill-'));
  try {
    fs.mkdirSync(path.join(tmp, 'runs', 'r1'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'runs', 'r1', 'a.log'), '[scheduler] memory scope sm-job-a-1: peak=1234MB oom_kill=0\n');
    const stats = createJobMemoryStats({ storePath: path.join(tmp, STORE_FILE), now: () => 1 });
    const boot = () => scheduler.backfillMemoryStats({ runsDir: path.join(tmp, 'runs'), backfillFromRunLogs: stats.backfillFromRunLogs });
    expect(await boot()).toBe(1);
    expect(stats.loadSamples().map((s) => s.peakMb)).toEqual([1234]);
    // Store still under 30: the next pass runs again; a new run is added, the old one is not repeated.
    fs.mkdirSync(path.join(tmp, 'runs', 'r2'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'runs', 'r2', 'b.log'), '[scheduler] memory scope sm-job-b-2: peak=800MB oom_kill=0\n');
    expect(await boot()).toBe(1);
    stats._resetCache();
    expect(stats.loadSamples().map((s) => s.peakMb)).toEqual([1234, 800]);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

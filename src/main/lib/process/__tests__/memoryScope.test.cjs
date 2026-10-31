import { describe, it, expect, beforeEach } from 'vitest';

const ms = require('../memoryScope.cjs');

const present = { existsSync: () => true };

describe('memoryLimitsFor', () => {
  it('defaults to 45% of RAM capped at 10240', () => {
    expect(ms.memoryLimitsFor({ totalRamMb: 16000, env: {} })).toEqual({
      memoryMaxMb: 7200, memoryHighMb: 6120, swapMaxMb: 4096,
    });
    expect(ms.memoryLimitsFor({ totalRamMb: 64000, env: {} }).memoryMaxMb).toBe(10240);
  });
  it('honours SM_JOB_MEMORY_MAX_MB', () => {
    expect(ms.memoryLimitsFor({ totalRamMb: 16000, env: { SM_JOB_MEMORY_MAX_MB: '2000' } })).toEqual({
      memoryMaxMb: 2000, memoryHighMb: 1700, swapMaxMb: 4096,
    });
  });
  it('returns null when disabled with 0', () => {
    expect(ms.memoryLimitsFor({ totalRamMb: 16000, env: { SM_JOB_MEMORY_MAX_MB: '0' } })).toBeNull();
  });
});

describe('wrapInMemoryScope', () => {
  it('builds the exact argv', () => {
    const out = ms.wrapInMemoryScope({
      command: '/bin/claude', args: ['-p', 'x y'], unit: 'sm job/1',
      limits: { memoryMaxMb: 100, memoryHighMb: 85, swapMaxMb: 4096 },
    });
    expect(out).toEqual({
      command: 'systemd-run',
      args: ['--user', '--scope', '--quiet', '--collect', '--unit=sm-job-1.scope',
        '-p', 'MemoryHigh=85M', '-p', 'MemoryMax=100M', '-p', 'MemorySwapMax=4096M',
        '-p', 'OOMPolicy=continue', '--', '/bin/claude', '-p', 'x y'],
    });
  });
  it('uses systemdRunPath and sanitizes the unit', () => {
    const out = ms.wrapInMemoryScope({
      command: 'c', unit: 'a b@c', systemdRunPath: '/usr/bin/systemd-run',
      limits: { memoryMaxMb: 1, memoryHighMb: 0, swapMaxMb: 0 },
    });
    expect(out.command).toBe('/usr/bin/systemd-run');
    expect(out.args).toContain('--unit=a-b-c.scope');
  });
});

describe('scopeSupported', () => {
  beforeEach(() => ms._resetScopeSupportCache());
  it('is true when probe exits 0, and caches', () => {
    let calls = 0;
    const spawnSync = () => { calls++; return { status: 0 }; };
    const d = { platform: 'linux', spawnSync, fs: present, env: { PATH: '/usr/bin' } };
    expect(ms.scopeSupported(d)).toBe(true);
    expect(ms.scopeSupported(d)).toBe(true);
    expect(calls).toBe(1);
  });
  it('is false off Linux', () => {
    expect(ms.scopeSupported({ platform: 'darwin', spawnSync: () => ({ status: 0 }), fs: present, env: { PATH: '/x' } })).toBe(false);
  });
  it('is false when systemd-run is not on PATH', () => {
    expect(ms.scopeSupported({ platform: 'linux', spawnSync: () => ({ status: 0 }), fs: { existsSync: () => false }, env: { PATH: '/x' } })).toBe(false);
  });
  it('is false when the probe fails', () => {
    expect(ms.scopeSupported({ platform: 'linux', spawnSync: () => ({ status: 1 }), fs: present, env: { PATH: '/x' } })).toBe(false);
  });
});

describe('stopScope', () => {
  it('never throws', () => {
    expect(ms.stopScope('u', { spawnSync: () => { throw new Error('boom'); } })).toBe(false);
  });
  it('stops the sanitized scope', () => {
    let seen;
    expect(ms.stopScope('a b', { spawnSync: (c, a) => { seen = [c, a]; return { status: 0 }; } })).toBe(true);
    expect(seen).toEqual(['systemctl', ['--user', 'stop', 'a-b.scope']]);
  });
});

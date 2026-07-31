// PRD 834 — machine-wide scheduler-ownership lock. Secondary instances must
// go scheduler-passive instead of running boot reconciliation / admin server
// against the owner's queue state (live incident 2026-07-31).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const {
  acquireSchedulerOwnership,
  releaseSchedulerOwnership,
  pidAlive,
  lockPath,
} = require('../instanceLock.cjs');

let dir;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-instance-lock-'));
  process.env.SM_SCHEDULER_LOCK_PATH = path.join(dir, 'scheduler-owner.lock');
});

afterEach(() => {
  delete process.env.SM_SCHEDULER_LOCK_PATH;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('instanceLock (PRD 834)', () => {
  it('first acquirer becomes owner and writes its pid', () => {
    const res = acquireSchedulerOwnership();
    expect(res.owner).toBe(true);
    const onDisk = JSON.parse(fs.readFileSync(lockPath(), 'utf8'));
    expect(onDisk.pid).toBe(process.pid);
  });

  it('a live foreign holder makes acquisition passive with the holder pid reported', () => {
    // Use our own live pid as the "foreign" holder — pidAlive(process.pid) is
    // true, and acquire treats pid !== process.pid as foreign, so fake one by
    // writing pid 1 (init — always alive, never ours).
    fs.mkdirSync(path.dirname(lockPath()), { recursive: true });
    fs.writeFileSync(lockPath(), JSON.stringify({ pid: 1, startedAt: 'x' }));
    const res = acquireSchedulerOwnership();
    expect(res.owner).toBe(false);
    expect(res.holderPid).toBe(1);
    // The holder's lock is untouched.
    expect(JSON.parse(fs.readFileSync(lockPath(), 'utf8')).pid).toBe(1);
  });

  it('a stale lock (dead pid) is broken and ownership taken', () => {
    // Find a pid that is certainly dead: spawn nothing — use a huge pid
    // beyond pid_max defaults.
    fs.mkdirSync(path.dirname(lockPath()), { recursive: true });
    fs.writeFileSync(lockPath(), JSON.stringify({ pid: 2 ** 30, startedAt: 'x' }));
    const res = acquireSchedulerOwnership();
    expect(res.owner).toBe(true);
    expect(JSON.parse(fs.readFileSync(lockPath(), 'utf8')).pid).toBe(process.pid);
  });

  it('re-acquiring our own lock stays owner (idempotent across re-init)', () => {
    expect(acquireSchedulerOwnership().owner).toBe(true);
    expect(acquireSchedulerOwnership().owner).toBe(true);
  });

  it('release removes only our own lock', () => {
    acquireSchedulerOwnership();
    releaseSchedulerOwnership();
    expect(fs.existsSync(lockPath())).toBe(false);
    // A foreign lock is never removed by release.
    fs.writeFileSync(lockPath(), JSON.stringify({ pid: 1, startedAt: 'x' }));
    releaseSchedulerOwnership();
    expect(fs.existsSync(lockPath())).toBe(true);
  });

  it('a corrupt lock file is treated as stale, not fatal', () => {
    fs.mkdirSync(path.dirname(lockPath()), { recursive: true });
    fs.writeFileSync(lockPath(), 'not json {');
    const res = acquireSchedulerOwnership();
    expect(res.owner).toBe(true);
  });

  it('pidAlive: own pid alive, absurd pid dead', () => {
    expect(pidAlive(process.pid)).toBe(true);
    expect(pidAlive(2 ** 30)).toBe(false);
    expect(pidAlive(-5)).toBe(false);
    expect(pidAlive(0)).toBe(false);
  });
});

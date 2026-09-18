// PRD 834 — machine-wide scheduler-ownership lock. Secondary instances must
// go scheduler-passive instead of running boot reconciliation / admin server
// against the owner's queue state (live incident 2026-07-31).
//
// HOME is stubbed to a mkdtemp dir BEFORE requiring instanceLock.cjs (mirrors
// scheduler-reconcile-invalid-repair.test.cjs): instanceLock.cjs pulls in
// auditLog.cjs, whose AUDIT_LOG_PATH is computed once at require time from
// os.homedir() — so real ~/.claude/session-manager state must never be
// touched by this suite.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let originalHome;
let tmpHome;
let instanceLock;
let AUDIT_LOG_PATH;

beforeAll(() => {
  originalHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-instance-lock-home-'));
  process.env.HOME = tmpHome;
  instanceLock = require('../instanceLock.cjs');
  ({ AUDIT_LOG_PATH } = require('../auditLog.cjs'));
  if (!AUDIT_LOG_PATH.startsWith(tmpHome)) {
    throw new Error(`refusing to run: AUDIT_LOG_PATH (${AUDIT_LOG_PATH}) is not under the temp HOME (${tmpHome})`);
  }
});

afterAll(() => {
  process.env.HOME = originalHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

// Thin pass-throughs so every test body below can keep calling these as
// bare names, resolved lazily against the module loaded in beforeAll.
const acquireSchedulerOwnership = (...args) => instanceLock.acquireSchedulerOwnership(...args);
const releaseSchedulerOwnership = (...args) => instanceLock.releaseSchedulerOwnership(...args);
const pidAlive = (...args) => instanceLock.pidAlive(...args);
const lockPath = (...args) => instanceLock.lockPath(...args);

function readAuditEvents() {
  if (!fs.existsSync(AUDIT_LOG_PATH)) return [];
  return fs.readFileSync(AUDIT_LOG_PATH, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

let dir;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-instance-lock-'));
  process.env.SM_SCHEDULER_LOCK_PATH = path.join(dir, 'scheduler-owner.lock');
});

afterEach(() => {
  delete process.env.SM_SCHEDULER_LOCK_PATH;
  delete process.env.SM_PROC_ROOT;
  fs.rmSync(dir, { recursive: true, force: true });
  if (fs.existsSync(AUDIT_LOG_PATH)) fs.rmSync(AUDIT_LOG_PATH, { force: true });
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

  it('a legacy lock ({pid, startedAt} only, no identity) is respected while its pid is alive', () => {
    // Mirrors the on-disk shape of every lock written before this PRD.
    fs.mkdirSync(path.dirname(lockPath()), { recursive: true });
    fs.writeFileSync(lockPath(), JSON.stringify({ pid: 1, startedAt: 'x' }));
    const res = acquireSchedulerOwnership();
    expect(res.owner).toBe(false);
    expect(res.holderPid).toBe(1);
    expect(JSON.parse(fs.readFileSync(lockPath(), 'utf8')).pid).toBe(1);
    // No identity information to compare, so no stale-lock-broken audit event.
    expect(readAuditEvents().some((e) => e.kind === 'stale_lock_broken')).toBe(false);
  });

  it('a recorded identity that no longer matches the live process at that (recycled) pid is broken, and audited', () => {
    // process.ppid is guaranteed alive for the lifetime of this test (the
    // vitest worker's own parent) — stand-in for "a hard crash left a lock
    // whose pid was later reused by an unrelated live process".
    const recycledPid = process.ppid;
    const procRoot = path.join(dir, 'proc');
    fs.mkdirSync(path.join(procRoot, String(recycledPid)), { recursive: true });
    fs.writeFileSync(
      path.join(procRoot, String(recycledPid), 'stat'),
      `${recycledPid} (bash) S 1 ${recycledPid} ${recycledPid} 0 -1 4194304 0 0 0 0 0 0 0 0 20 0 1 0 222222 0 0 0 0 0 0 0 0 0 0 0 0 0 17 0 0 0 0 0 0 0 0 0 0 0 0\n`,
    );
    fs.writeFileSync(path.join(procRoot, String(recycledPid), 'cmdline'), 'bash\0');
    process.env.SM_PROC_ROOT = procRoot;

    fs.mkdirSync(path.dirname(lockPath()), { recursive: true });
    fs.writeFileSync(lockPath(), JSON.stringify({
      pid: recycledPid,
      startedAt: 'x',
      // The identity the crashed scheduler instance actually recorded — a
      // different cmdline/startTicks than the process now holding this pid.
      identity: { pid: recycledPid, startTicks: 111111, cmdline: 'claude --session-id old', complete: true },
    }));

    const res = acquireSchedulerOwnership();
    expect(res.owner).toBe(true);
    expect(JSON.parse(fs.readFileSync(lockPath(), 'utf8')).pid).toBe(process.pid);

    const auditEvents = readAuditEvents().filter((e) => e.kind === 'stale_lock_broken');
    expect(auditEvents.length).toBe(1);
    expect(auditEvents[0].recordedPid).toBe(recycledPid);
  });

  it('writeLockExclusive (via acquire) records a complete identity for this process', () => {
    acquireSchedulerOwnership();
    const onDisk = JSON.parse(fs.readFileSync(lockPath(), 'utf8'));
    expect(onDisk.identity).toBeTruthy();
    expect(onDisk.identity.pid).toBe(process.pid);
    expect(onDisk.identity.complete).toBe(true);
  });
});

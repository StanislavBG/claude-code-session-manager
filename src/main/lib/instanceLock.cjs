/**
 * instanceLock.cjs — machine-wide scheduler-ownership lock (PRD 834).
 *
 * Electron's app.requestSingleInstanceLock() is keyed by userData path, so an
 * instance launched with a different identity bypasses it entirely — live
 * incident 2026-07-31: a Playwright `_electron.launch(src/main/index.cjs)`
 * runs as the "Electron" default app (userData ~/.config/Electron), won its
 * own Electron lock, ran full scheduler boot reconciliation against the same
 * per-project queue state as the production instance, SIGTERM'd the
 * production instance's live job as an "orphan", and overwrote
 * admin-api.json. Dev/e2e launches skip the Electron lock on purpose, with
 * the same effect.
 *
 * This lock is identity-independent: a pid file at a FIXED path under
 * ~/.claude/session-manager/. Exactly one process — whichever wins the
 * atomic 'wx' create — owns scheduler mutation (boot reconciliation, queue
 * ticking, feedback sweep, supervisor, heartbeat) and the admin API. Every
 * other instance runs scheduler-passive: UI reads still work (IPC read
 * handlers register unconditionally), but nothing that mutates queue state
 * or kills processes runs.
 *
 * Deliberately plain sync fs (no config.cjs writeJson): this runs before
 * app.whenReady and must not await; the file is tiny and single-writer.
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Env override is for unit tests only (isolates the lock from the real
// ~/.claude of the machine running the suite).
function lockPath() {
  return process.env.SM_SCHEDULER_LOCK_PATH
    || path.join(os.homedir(), '.claude', 'session-manager', 'scheduler-owner.lock');
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM = alive but not ours; ESRCH = dead.
    return e && e.code === 'EPERM';
  }
}

function readLock() {
  try {
    const raw = fs.readFileSync(lockPath(), 'utf8');
    const parsed = JSON.parse(raw);
    return Number.isInteger(parsed?.pid) ? parsed : null;
  } catch {
    return null;
  }
}

function writeLockExclusive() {
  const body = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() });
  fs.mkdirSync(path.dirname(lockPath()), { recursive: true });
  // 'wx' = atomic create-or-fail — two racing instances cannot both win.
  fs.writeFileSync(lockPath(), body, { flag: 'wx', mode: 0o600 });
}

/**
 * Try to become the machine's scheduler owner.
 * Returns { owner: true } or { owner: false, holderPid } — never throws.
 */
function acquireSchedulerOwnership() {
  for (let attempt = 0; attempt < 2; attempt++) {
    const existing = readLock();
    if (existing && existing.pid !== process.pid && pidAlive(existing.pid)) {
      return { owner: false, holderPid: existing.pid };
    }
    // Missing, unreadable, our own, or stale (holder pid dead) — take it.
    try {
      if (existing || fs.existsSync(lockPath())) fs.unlinkSync(lockPath());
    } catch { /* raced with another breaker — retry loop below settles it */ }
    try {
      writeLockExclusive();
      return { owner: true };
    } catch {
      // Lost the create race — loop once more to report the winner's pid.
    }
  }
  const winner = readLock();
  return { owner: false, holderPid: winner?.pid };
}

/** Best-effort release on clean shutdown; stale-pid detection covers crashes. */
function releaseSchedulerOwnership() {
  try {
    const existing = readLock();
    if (existing && existing.pid === process.pid) fs.unlinkSync(lockPath());
  } catch { /* nothing to release */ }
}

module.exports = { acquireSchedulerOwnership, releaseSchedulerOwnership, pidAlive, lockPath };

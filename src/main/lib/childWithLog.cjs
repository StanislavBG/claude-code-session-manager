'use strict';

/**
 * childWithLog.cjs — spawn a child process with a log fd and watchdog timers.
 *
 * Two-phase API so callers can emit pre-spawn log lines (e.g. "starting …",
 * early-exit error messages) before the child is created, while still having
 * the helper own the fd lifecycle end-to-end.
 *
 * Phase 1 — openLog(logPath)
 *   Opens the log file in append mode. Returns { fd, safeLog, closeFd }.
 *   safeLog: idempotent after closeFd; never throws (guards EBADF on timers).
 *   closeFd: idempotent; closes the fd exactly once.
 *   After calling withChildAndLog(), do NOT call closeFd() yourself — the
 *   helper takes ownership and closes it once after onExit returns.
 *
 * Phase 2 — withChildAndLog({ fd, logPath, safeLog, closeFd, spawn, watchdogs, onExit })
 *   Spawns the child with stdio piped to the open fd.
 *   Manages the watchdog timer lifecycle:
 *     - Each watchdog uses setInterval. The interval auto-clears the first time
 *       shouldFire(ctx) returns true, then calls action(ctx).
 *     - action() may call ctx.addTimer(t) to register secondary timers
 *       (e.g. SIGTERM → SIGKILL cascades) so they are also cleared on exit.
 *   Calls onExit() synchronously inside the child 'exit'/'error' handler,
 *   before calling closeFd(). Caller may call ctx.safeLog() inside onExit.
 *
 * WatchdogContext:
 *   child         — the ChildProcess (null if spawn threw synchronously)
 *   logPath       — string, used by watchdogs that stat the log file
 *   startedAt     — Date.now() at spawn time
 *   safeLog       — same safeLog returned by openLog()
 *   killedByWatchdog — string | null, mutable; set by action() to record which
 *                      watchdog issued the kill
 *   killTree(sig) — sends sig to the process group (falls back to child.kill)
 *   addTimer(t)   — registers a secondary timer (clearTimeout-compatible)
 *
 * onExit info:
 *   exitCode      — number | null (−1 on spawn failure or child 'error' event)
 *   signal        — string | null
 *   killedByWatchdog — string | null
 *   error         — Error | undefined (child 'error' event or sync spawn throw)
 *   spawnFailed   — boolean, true when the error came from a synchronous spawn throw
 *   safeLog       — same safeLog (usable inside onExit for final log lines)
 *
 * Returns { child, cancel } where cancel() clears all timers + SIGKILLs.
 * child is null when the synchronous spawn threw (onExit has already been called).
 */

const fs = require('node:fs');
const { spawn } = require('node:child_process');

// Grace period between the post-exit SIGTERM sweep and the follow-up SIGKILL
// sweep of a detached child's process group. See sweepChildProcessGroup below.
const POST_EXIT_GROUP_SWEEP_GRACE_MS = 5000;

// ---------- Phase 1 ----------

/**
 * Open a log file in append mode. Returns { fd, safeLog, closeFd }.
 *
 * @param {string} logPath
 * @returns {{ fd: number, safeLog: (msg: string) => void, closeFd: () => void }}
 */
function openLog(logPath) {
  const fd = fs.openSync(logPath, 'a');
  let fdClosed = false;

  const closeFd = () => {
    if (fdClosed) return;
    fdClosed = true;
    try { fs.closeSync(fd); } catch { /* already closed */ }
  };

  // safeLog: no-op once the fd is closed, never throws.
  // Pre-fix for EBADF: a watchdog timer firing after closeFd would throw and
  // crash the host if we used fs.writeSync directly.
  const safeLog = (msg) => {
    if (fdClosed) return;
    try { fs.writeSync(fd, msg); } catch { /* fd vanished mid-write */ }
  };

  return { fd, safeLog, closeFd };
}

// ---------- Phase 2 ----------

/**
 * @typedef {Object} WatchdogSpec
 * @property {string} label
 * @property {number} intervalMs — poll interval
 * @property {(ctx: WatchdogContext) => boolean} shouldFire — return true to
 *   fire action + auto-clear the interval (fire-once-on-condition)
 * @property {(ctx: WatchdogContext) => void} action
 */

/**
 * @typedef {Object} WatchdogContext
 * @property {import('child_process').ChildProcess | null} child
 * @property {string} logPath
 * @property {number} startedAt
 * @property {(msg: string) => void} safeLog
 * @property {string | null} killedByWatchdog
 * @property {(signal: string) => boolean} killTree
 * @property {(timer: any) => void} addTimer
 */

/**
 * @param {{
 *   fd: number,
 *   logPath: string,
 *   safeLog: (msg: string) => void,
 *   closeFd: () => void,
 *   spawn: { command: string, args: string[], options: object },
 *   watchdogs?: WatchdogSpec[],
 *   onExit?: (info: {
 *     exitCode: number | null,
 *     signal: string | null,
 *     killedByWatchdog: string | null,
 *     error?: Error,
 *     spawnFailed?: boolean,
 *     safeLog: (msg: string) => void,
 *   }) => void,
 * }} opts
 * @returns {{ child: import('child_process').ChildProcess | null, cancel: () => void }}
 */
// Post-exit process-group sweep.
//
// Incident (2026-08-31, ~/Projects/starry-night-ships): scheduler jobs spawn
// detached: true, and every watchdog path (result-tail, deadman, idle-tail)
// kills the whole process group via ctx.killTree — but only on an *overrun*
// exit. When the executor child exits normally, nothing swept the group, so
// anything the agent had backgrounded to work around the foreground call cap
// (the `bash -c '<gate> > /tmp/x.log; echo $? > /tmp/x.done'` shape) reparented
// to init and kept running for nobody: three orphaned test batteries at PPID 1
// were found, one burning ~5 cores for 56 minutes. The invariant this restores:
// a job's descendants must not outlive the job. Killing the job's own process
// group at the job's own exit is ownership-based and needs no /proc heuristics
// to distinguish an abandoned descendant from a live one.
function sweepChildProcessGroup(child, detached) {
  if (!detached) return;
  if (!child || !child.pid || child.pid <= 1) return;
  // Defensive: never target the Session Manager process's own group.
  if (child.pid === process.pid) return;

  try { process.kill(-child.pid, 'SIGTERM'); } catch { /* ESRCH: empty group, the normal case */ }

  const t = setTimeout(() => {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* ESRCH: empty group, the normal case */ }
  }, POST_EXIT_GROUP_SWEEP_GRACE_MS);
  if (t.unref) t.unref();
}

function withChildAndLog({ fd, logPath, safeLog, closeFd, spawn: spawnSpec, watchdogs = [], onExit }) {
  const startedAt = Date.now();

  // Secondary timers registered by watchdog actions (e.g. SIGTERM → SIGKILL cascades).
  // Cleared alongside the primary watchdog timers on child exit.
  // clearTimeout works on both Timeout and Interval handles in Node.js.
  const extraTimers = [];

  /** @type {WatchdogContext} */
  const ctx = {
    child: null,
    logPath,
    startedAt,
    safeLog,
    killedByWatchdog: null,
    killTree(signal) {
      const c = ctx.child;
      if (!c) return false;
      // Negative pid targets the whole process group (requires detached: true at spawn).
      // Falls back to direct kill if the process is not a group leader.
      try { process.kill(-c.pid, signal); return true; }
      catch {
        try { process.kill(c.pid, signal); return true; }
        catch { return false; /* already dead */ }
      }
    },
    addTimer(t) { extraTimers.push(t); },
  };

  // Build interval-based watchdog timers. Each fires every intervalMs; the
  // first time shouldFire(ctx) returns true, the interval is auto-cleared and
  // action(ctx) is called (fire-once-on-condition semantics).
  //
  // O(|watchdogs|) setup, O(1) per poll tick.
  const clearFns = watchdogs.map((wd) => {
    const t = setInterval(() => {
      if (wd.shouldFire(ctx)) {
        clearInterval(t);
        wd.action(ctx);
      }
    }, wd.intervalMs);
    if (t.unref) t.unref();
    return () => clearInterval(t);
  });

  const clearAllTimers = () => {
    clearFns.forEach((fn) => fn());
    extraTimers.forEach((t) => clearTimeout(t));
  };

  // handleDone: called from both 'error' and 'exit' handlers. Clears timers,
  // calls onExit (caller may still safeLog inside), then closes the fd.
  const handleDone = (exitCode, signal, error, spawnFailed) => {
    clearAllTimers();
    if (onExit) {
      onExit({
        exitCode,
        signal: signal ?? null,
        killedByWatchdog: ctx.killedByWatchdog,
        error,
        spawnFailed: spawnFailed ?? false,
        safeLog,
      });
    }
    sweepChildProcessGroup(ctx.child, !!spawnSpec.options?.detached);
    closeFd();
  };

  // Attempt synchronous spawn. On failure, call handleDone immediately so the
  // caller's onExit can resolve any pending Promise before we return null.
  let child;
  try {
    child = spawn(spawnSpec.command, spawnSpec.args, {
      ...spawnSpec.options,
      stdio: ['ignore', fd, fd],
    });
  } catch (e) {
    handleDone(-1, null, e, /* spawnFailed */ true);
    return { child: null, cancel: () => {} };
  }

  ctx.child = child;

  child.on('error', (err) => handleDone(-1, null, err, false));
  child.on('exit', (code, signal) => handleDone(code, signal, undefined, false));

  const cancel = () => {
    clearAllTimers();
    // Best-effort kill; ignore errors (process may already be gone).
    try { process.kill(-child.pid, 'SIGKILL'); } catch {
      try { child.kill('SIGKILL'); } catch { /* */ }
    }
  };

  return { child, cancel };
}

module.exports = { openLog, withChildAndLog, POST_EXIT_GROUP_SWEEP_GRACE_MS };

'use strict';

/**
 * pidAlive.cjs — single source of truth for "is this pid alive" liveness.
 *
 * Four independent copies of this exact check had drifted apart:
 * reaperHelpers.cjs's claudePidAlive (bug: caught EPERM and returned false,
 * never crediting a pid it couldn't signal but which demonstrably exists),
 * watchdogHelpers.cjs's isPidAlive, reservationExpiry.cjs's defaultPidAlive,
 * and instanceLock.cjs's pidAlive (these three already treated EPERM as
 * alive, but each reimplemented the same three lines). This module is now
 * the one place the rule lives; the others re-export thin aliases so every
 * existing import keeps working.
 *
 * Rule: an invalid pid (not an integer, or <= 1 — pid 1 is init/launchd,
 * never a real target) is never alive. `process.kill(pid, 0)` (no signal
 * sent) succeeding means the pid exists and we can signal it → alive. EPERM
 * (pid exists, owned by another user — we just can't signal it) also counts
 * as alive: the process demonstrably exists. Anything else (ESRCH — no such
 * process) → dead.
 */
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code === 'EPERM';
  }
}

module.exports = { pidAlive };

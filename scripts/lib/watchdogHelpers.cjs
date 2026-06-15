'use strict';

// watchdogHelpers.cjs — pure helpers for scheduler-watchdog.cjs (no side effects).
// Testable without spawning the watchdog entry script.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Relative path into src/main/lib/ — the watchdog is external to the app, so
// we re-use the helpers without importing any Electron code.
// (Same claudePidAlive + classifyRunOutcome used by scheduler.cjs boot reconciliation.)
const { claudePidAlive, classifyRunOutcome } = require('../../src/main/lib/reaperHelpers.cjs');

// Mirrors scheduler.cjs:99.
const ORPHAN_REQUEUE_CAP = 2;

// Mirrors scheduler.cjs:215 (single source of truth there; kept in sync here).
const DEFAULT_HEARTBEAT_PATH = path.join(
  os.homedir(), '.claude', 'session-manager', 'scheduler-heartbeat.log',
);

// The in-app heartbeat ticks every 60 s; 3 missed ticks = stale.
const DEFAULT_MAX_AGE_MS = 180_000;

// Tail bytes to read — enough to hold several JSON heartbeat lines without
// loading a potentially 1 MB file. O(1) in file size.
const TAIL_BYTES = 4096;

/**
 * readLastHeartbeatTs(heartbeatPath?) → number | null
 *
 * Reads the last ~4 KB of the heartbeat log, reverse-scans for the last
 * non-empty line, parses its `ts` field (epoch ms), and returns it.
 * Returns null on missing / empty / unparseable file or missing ts field.
 *
 * Single source of truth for the file-read + reverse-scan logic; used by
 * both heartbeatFresh() and the watchdog entry script's log annotation.
 */
function readLastHeartbeatTs(heartbeatPath = DEFAULT_HEARTBEAT_PATH) {
  let buf;
  try {
    const stat = fs.statSync(heartbeatPath);
    const size = stat.size;
    if (size === 0) return null;

    const readSize = Math.min(TAIL_BYTES, size);
    const fd = fs.openSync(heartbeatPath, 'r');
    try {
      buf = Buffer.alloc(readSize);
      fs.readSync(fd, buf, 0, readSize, size - readSize);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }

  const lines = buf.toString('utf8').split('\n');
  // Walk lines in reverse to find last non-empty parseable one.
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const parsed = JSON.parse(line);
      return typeof parsed.ts === 'number' ? parsed.ts : null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * heartbeatFresh(heartbeatPath?, maxAgeMs?) → boolean
 *
 * Returns true iff the last heartbeat ts is within maxAgeMs of `now`.
 * Missing / empty / unparseable file → false.
 */
function heartbeatFresh(heartbeatPath = DEFAULT_HEARTBEAT_PATH, maxAgeMs = DEFAULT_MAX_AGE_MS) {
  const ts = readLastHeartbeatTs(heartbeatPath);
  if (ts === null) return false;
  return (Date.now() - ts) < maxAgeMs;
}

// Default paths — callers can override via opts for testing.
const DEFAULT_QUEUE_PATH = path.join(
  os.homedir(), '.claude', 'session-manager', 'scheduled-plans', 'queue.json',
);
const DEFAULT_RUNS_DIR = path.join(
  os.homedir(), '.claude', 'session-manager', 'scheduled-plans', 'runs',
);

/**
 * reconcileQueueOffline(opts?) → { reconciled: boolean, reapedCount: number, errors: string[] }
 *
 * Safe offline reconciliation of queue.json when the in-app scheduler is down.
 *
 * Guard: re-checks heartbeatFresh() at the top and returns a no-op result if the
 * app is alive — the app owns the mutate lock and concurrent writes corrupt the queue.
 *
 * When stale: for each running job whose PID is dead (or whose app is dead):
 *   success    → completed
 *   failed     → failed
 *   no_result / unknown → re-queue to pending (bounded by ORPHAN_REQUEUE_CAP)
 *
 * If the PID is still alive but the app is dead, SIGTERM it before classifying.
 *
 * Atomic write: queue.json.tmp-<pid>-<ts> → rename (mirrors config.cjs writeJsonSync).
 *
 * O(n) in number of running jobs; classifyRunOutcome tails up to 64 KB per job.
 */
function reconcileQueueOffline({
  heartbeatPath = DEFAULT_HEARTBEAT_PATH,
  maxAgeMs = DEFAULT_MAX_AGE_MS,
  queuePath = DEFAULT_QUEUE_PATH,
  runsDir = DEFAULT_RUNS_DIR,
} = {}) {
  // Safety guard: never touch queue.json while the app is alive.
  if (heartbeatFresh(heartbeatPath, maxAgeMs)) {
    return { reconciled: false, reapedCount: 0, errors: [] };
  }

  let state;
  try {
    state = JSON.parse(fs.readFileSync(queuePath, 'utf8'));
  } catch (e) {
    return { reconciled: false, reapedCount: 0, errors: [`read queue.json: ${e?.message}`] };
  }

  const errors = [];
  let reapedCount = 0;
  // Stamp once so all jobs reapedQueue in the same watchdog run share a finishedAt.
  const reconciledAt = new Date().toISOString();

  for (const j of (state.jobs ?? [])) {
    if (j.status !== 'running') continue;

    const logPath = j.runId ? path.join(runsDir, j.runId, `${j.slug}.log`) : null;

    // If PID is alive and the app is dead: SIGTERM to stop the orphan.
    if (j.runtime?.pid && claudePidAlive(j.runtime.pid)) {
      try { process.kill(j.runtime.pid, 'SIGTERM'); } catch { /* ESRCH — already gone */ }
    }

    const outcome = logPath ? classifyRunOutcome(logPath) : 'unknown';

    if (outcome === 'success') {
      j.status = 'completed';
      j.exitCode = 0;
      j.error = null;
      j.finishedAt = reconciledAt;
      delete j.runtime;
      delete j.verifierVerdict;
    } else if (outcome === 'failed') {
      j.status = 'failed';
      j.exitCode = j.exitCode ?? 1;
      j.error = 'orphaned: watchdog found failed result while app was down';
      j.finishedAt = reconciledAt;
      delete j.runtime;
      delete j.verifierVerdict;
    } else {
      // no_result / unknown: interrupted with no evidence of merit failure — re-queue bounded.
      const tries = j.orphanRetries ?? 0;
      if (tries < ORPHAN_REQUEUE_CAP) {
        j.status = 'pending';
        j.runId = null;
        j.startedAt = null;
        j.finishedAt = null;
        j.exitCode = null;
        j.error = `orphaned: watchdog re-queued (attempt ${tries + 1}/${ORPHAN_REQUEUE_CAP})`;
        j.orphanRetries = tries + 1;
        delete j.runtime;
        delete j.verifierVerdict;
      } else {
        j.status = 'failed';
        j.exitCode = j.exitCode ?? 1;
        j.error = `orphaned: watchdog exhausted ${ORPHAN_REQUEUE_CAP} re-queue attempts`;
        j.finishedAt = reconciledAt;
        delete j.runtime;
        delete j.verifierVerdict;
      }
    }

    reapedCount++;
  }

  if (reapedCount === 0) {
    return { reconciled: false, reapedCount: 0, errors };
  }

  // Atomic write: tmp-<pid>-<ts> → rename (mirrors config.cjs writeJsonSync).
  const tmpPath = `${queuePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2) + '\n', 'utf8');
    fs.renameSync(tmpPath, queuePath);
  } catch (e) {
    errors.push(`write queue.json: ${e?.message}`);
    try { fs.unlinkSync(tmpPath); } catch { /* best-effort cleanup */ }
    return { reconciled: false, reapedCount: 0, errors };
  }

  return { reconciled: true, reapedCount, errors };
}

/**
 * sweep() — stub; PRD 102 fills in the real feedback-sweep implementation.
 * Returns a structured result so the entry wiring and callers compile correctly.
 */
function sweep() {
  return { swept: false, stub: true };
}

module.exports = {
  readLastHeartbeatTs,
  heartbeatFresh,
  reconcileQueueOffline,
  sweep,
  DEFAULT_HEARTBEAT_PATH,
  DEFAULT_MAX_AGE_MS,
};

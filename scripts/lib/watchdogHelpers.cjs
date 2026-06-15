'use strict';

// watchdogHelpers.cjs — pure helpers for scheduler-watchdog.cjs (no side effects).
// Testable without spawning the watchdog entry script.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

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

/**
 * reconcileQueueOffline() — stub; PRD 100 fills in the real implementation.
 * Returns a structured result so the entry wiring and callers compile correctly.
 */
function reconcileQueueOffline() {
  return { reconciled: false, stub: true };
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

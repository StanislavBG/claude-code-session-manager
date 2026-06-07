'use strict';

/**
 * reaperHelpers.cjs — pure helpers for the dead-process reaper in scheduler.cjs.
 *
 * Kept in a separate lib file so they can be unit-tested without importing
 * scheduler.cjs (which requires electron/ipcMain).
 */

const fs = require('node:fs');
const { readTail } = require('./fileTail.cjs');

/**
 * Return true if pid is alive AND its cmdline looks like a claude process.
 *
 * Guards against PID recycling: on Linux we read /proc/<pid>/cmdline and
 * require /\bclaude\b/ in the command. On macOS (no /proc) we can't read
 * cmdline, so we conservatively return true — never false-reap a live PID
 * just because we can't verify its identity.
 *
 * Conservative by design: a false negative (live process treated as dead) is
 * far worse than a late reap.
 */
function claudePidAlive(pid) {
  if (!pid || typeof pid !== 'number' || pid <= 1) return false;
  try { process.kill(pid, 0); } catch { return false; }
  try {
    const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ');
    return /\bclaude\b/.test(cmd);
  } catch {
    // Can't read cmdline (macOS, permission denied) → assume alive.
    return true;
  }
}

/**
 * Classify the terminal outcome of a completed run by reading the last 64 KB
 * of its log file and scanning for the LAST `{"type":"result"}` JSONL event.
 *
 * Returns:
 *   'success'   — last result event has subtype=success and is_error !== true
 *   'failed'    — last result event exists but indicates an error
 *   'no_result' — no result event found in the tail (process may have been killed
 *                 before emitting one, or the log is absent/empty)
 *   'unknown'   — unexpected error reading/parsing (outer catch)
 */
function classifyRunOutcome(logPath) {
  try {
    const text = readTail(logPath, 65536);
    let lastResult = null;
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (!t.startsWith('{')) continue;
      try {
        const obj = JSON.parse(t);
        if (obj && obj.type === 'result') lastResult = obj;
      } catch { /* partial line at tail boundary or non-JSON scheduler log line */ }
    }
    if (!lastResult) return 'no_result';
    if (lastResult.subtype === 'success' && lastResult.is_error !== true) return 'success';
    return 'failed';
  } catch {
    return 'unknown';
  }
}

module.exports = { claudePidAlive, classifyRunOutcome };

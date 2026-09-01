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

// Max times an orphaned job may be re-queued before giving up (marking failed).
// Single source of truth: both the in-app reaper (scheduler.cjs) and the external
// offline watchdog (watchdogHelpers.cjs) import this so their give-up budgets can
// never drift apart (they increment the SAME j.orphanRetries field).
const ORPHAN_REQUEUE_CAP = 5;

/**
 * selectReapableJobs(jobs, now, { pidAlive, grace }) → { reapable, warnings }
 *
 * Pure predicate (no IO — `pidAlive` is injected) deciding which 'running'
 * rows reapDeadRunningJobs() should finalize this cycle. Two distinct dead
 * shapes:
 *  - has a runtime.pid, but the process is gone (pidAlive(pid) === false):
 *    the existing, unchanged behaviour.
 *  - has NO runtime.pid at all: previously skipped forever ("spawn may be
 *    mid-flight; give it a cycle" with no age bound). Now reaped once
 *    `startedAt` is older than `grace` — the spawn never got far enough to
 *    record a pid and nothing pid-bound can ever catch it (see
 *    PIDLESS_SPAWN_GRACE_MS's header for why the grace window is safe).
 *
 * A pidless row whose `startedAt` is missing or unparseable is neither
 * reaped nor skipped silently — age can't be proven, so it is surfaced in
 * `warnings` instead (the caller logs it) and left alone.
 */
function selectReapableJobs(jobs, now, { pidAlive, grace } = {}) {
  const reapable = [];
  const warnings = [];
  for (const j of jobs ?? []) {
    if (j.status !== 'running') continue;
    const pid = j.runtime?.pid;
    if (pid) {
      if (pidAlive(pid)) continue;
      reapable.push({ slug: j.slug, pid, pidless: false });
      continue;
    }
    const startedAt = Date.parse(j.startedAt ?? '');
    if (Number.isNaN(startedAt)) {
      warnings.push({ slug: j.slug, reason: 'pidless row with missing/unparseable startedAt — cannot prove age' });
      continue;
    }
    const ageMs = now - startedAt;
    if (ageMs < grace) continue; // spawn may still be mid-flight
    reapable.push({
      slug: j.slug,
      pid: null,
      pidless: true,
      reason: `reaped: no runtime.pid recorded after ${Math.round(grace / 60_000)}m — spawn never completed`,
    });
  }
  return { reapable, warnings };
}

module.exports = { claudePidAlive, classifyRunOutcome, ORPHAN_REQUEUE_CAP, selectReapableJobs };

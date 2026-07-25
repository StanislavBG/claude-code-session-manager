'use strict';

// scheduler-watchdog.cjs — external check-and-exit watchdog for the scheduler.
//
// Designed to run from a systemd user timer (or cron) independently of the
// Electron app. Reads the scheduler heartbeat, decides alive vs stale, dispatches
// to the appropriate branch, and exits 0.
//
// Alive  (heartbeat fresh) → exit immediately; do not touch queue.json.
// Stale/absent             → reconcileQueueOffline() + sweep(), then exit.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  readLastHeartbeatTs,
  reconcileQueueOffline,
  sweep,
  localDateStr,
  maybeFinalizeHistory,
  DEFAULT_HEARTBEAT_PATH,
  DEFAULT_MAX_AGE_MS,
} = require('./lib/watchdogHelpers.cjs');

// ---------- paths ----------

const LOGS_DIR = path.join(os.homedir(), '.claude', 'session-manager', 'logs');

function logPath() {
  return path.join(LOGS_DIR, `watchdog-${localDateStr()}.log`);
}

// ---------- logging ----------

function appendLog(entry) {
  try {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
    fs.appendFileSync(logPath(), JSON.stringify(entry) + '\n');
  } catch (e) {
    process.stderr.write(`[watchdog] log write failed: ${e?.message}\n`);
  }
}

// ---------- history rollup finalize ----------

/**
 * Runs the once-per-day History rollup finalize step. Never allowed to
 * throw or block: wrapped in try/catch and only ever called after the
 * heartbeat-gated reconcile/sweep work above has already completed, so a
 * slow or failing finalize pass can't delay them.
 */
async function runHistoryFinalize() {
  try {
    const result = await maybeFinalizeHistory();
    const status = result.ran ? (result.reason === 'partial' ? 'partial' : 'finalized') : 'skipped';
    return { status, reason: result.reason, date: result.date, finalizedDates: result.finalizedDates };
  } catch (e) {
    return { status: 'error', error: e?.message };
  }
}

// ---------- main ----------

async function main() {
  const now = Date.now();

  // Single read: derive both heartbeatAgeMs (for the log) and fresh (for
  // branching) from the same snapshot so they are always consistent.
  const lastTs = readLastHeartbeatTs(DEFAULT_HEARTBEAT_PATH);
  const heartbeatAgeMs = lastTs !== null ? now - lastTs : null;
  const fresh = lastTs !== null && heartbeatAgeMs < DEFAULT_MAX_AGE_MS;
  const decision = fresh ? 'alive' : 'stale';

  const logEntry = { ts: now, decision, heartbeatAgeMs, maxAgeMs: DEFAULT_MAX_AGE_MS };

  if (fresh) {
    // Alive branch: do nothing that touches queue.json. Let the in-app
    // scheduler manage its own queue to avoid races.
    const history = await runHistoryFinalize();
    appendLog({ ...logEntry, history });
    process.exit(0);
  }

  // Stale branch: app is absent or not updating heartbeat.
  const reconcileResult = reconcileQueueOffline();
  const sweepResult = sweep();
  const history = await runHistoryFinalize();

  appendLog({ ...logEntry, reconcile: reconcileResult, sweep: sweepResult, history });
  process.exit(0);
}

main().catch((e) => {
  process.stderr.write(`[watchdog] fatal: ${e?.message}\n`);
  process.exit(1);
});

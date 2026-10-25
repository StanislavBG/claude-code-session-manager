'use strict';

// Name this process first (pn-03): otherwise it shows as a bare `node`.
const { PROC_NAMES, setProcessTitle } = require('../src/main/lib/process/smProcNames.cjs');
if (require.main === module) setProcessTitle(PROC_NAMES.watchdog);

// scheduler-watchdog.cjs — external check-and-exit watchdog for session-manager.
//
// Designed to run from a systemd user timer (or cron) independently of the
// Electron app. Its ONE supervision job (post PRD 685 + PRD 686): read the
// scheduler heartbeat, decide alive vs stale, and if stale-and-dead, relaunch
// the app. Nothing else — queue.json reconciliation (orphaned 'running' jobs)
// and the feedback-auto-PRD sweep both moved into scheduler.cjs's own boot
// path / poll loop (PRD 686), since that in-process code is the single owner
// of queue.json and can now run continuously instead of only while the app is
// down. Do not reintroduce queue-mutating or feedback-scanning logic here —
// extend scheduler.cjs instead.
//
// Alive  (heartbeat fresh) → exit immediately; do not touch queue.json.
// Stale/absent             → maybeRelaunchApp(), then exit.
//
// (History-rollup finalize below is a separate, older concern (PRD 650) —
// precomputing closed History-dashboard days outside Electron — unrelated to
// queue/feedback ownership and out of scope for PRD 686's consolidation.)

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const {
  readLastHeartbeat,
  evaluateDispatchLiveness,
  localDateStr,
  maybeFinalizeHistory,
  maybeRelaunchApp,
  resetRelaunchState,
  DEFAULT_MAX_AGE_MS,
} = require('../src/main/lib/scheduler/watchdogHelpers.cjs');
const schedulerPaths = require('../src/main/lib/scheduler/schedulerPaths.cjs');
const { appendAuditEvent } = require('../src/main/lib/telemetry/auditLog.cjs');

// ---------- paths ----------

function logPath() {
  return path.join(schedulerPaths.watchdogLogsDir(), `watchdog-${localDateStr()}.log`);
}

// ---------- logging ----------

function appendLog(entry) {
  try {
    fs.mkdirSync(schedulerPaths.watchdogLogsDir(), { recursive: true });
    fs.appendFileSync(logPath(), JSON.stringify(entry) + '\n');
  } catch (e) {
    process.stderr.write(`[watchdog] log write failed: ${e?.message}\n`);
  }
}

// ---------- alert / alive-throttle / log-prune helpers ----------

const ALIVE_HEARTBEAT_MS = 60 * 60_000;
const LOG_RETENTION_MS = 14 * 24 * 60 * 60_000;
const ALERT_TITLE = 'Session Manager scheduler is down';
const ALERT_BODY = 'Watchdog could not bring the app back; it keeps retrying every 30 min. Start it manually if you can.';
const REALERT_MS = 60 * 60_000;

function alertStatePath() {
  return path.join(schedulerPaths.watchdogLogsDir(), 'watchdog-state.json');
}

function readAlertState(statePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeAlertState(statePath, state) {
  try {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify(state) + '\n');
  } catch (e) {
    process.stderr.write(`[watchdog] state write failed: ${e?.message}\n`);
  }
}

/** Desktop notification, no shell, failures ignored. */
function sendDesktopNotification(title, body, platform = process.platform, spawnFn = spawn) {
  try {
    let cmd;
    let args;
    if (platform === 'darwin') {
      const esc = (t) => String(t).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      cmd = 'osascript';
      args = ['-e', `display notification "${esc(body)}" with title "${esc(title)}"`];
    } else if (platform === 'linux') {
      cmd = 'notify-send';
      args = [title, body];
    } else {
      return false;
    }
    const child = spawnFn(cmd, args, { stdio: 'ignore', detached: true });
    if (child && typeof child.on === 'function') child.on('error', () => {});
    if (child && typeof child.unref === 'function') child.unref();
    return true;
  } catch {
    return false;
  }
}

/**
 * Pure transition: given this tick's outcome, return the next state and
 * whether to alert. Alerts on entering backoff and again once the stored
 * lastAlertTs is >= REALERT_MS old; a fresh tick clears it. A legacy
 * 'capped' reason is treated like 'backoff'.
 */
function nextAlertState(state, { fresh, relaunch, now = Date.now() }) {
  const prev = state && state.alerted === true;
  const lastAlertTs = state && typeof state.lastAlertTs === 'number' ? state.lastAlertTs : null;
  if (fresh) return { alert: false, alerted: false };
  if (relaunch && (relaunch.reason === 'backoff' || relaunch.reason === 'capped')) {
    const due = !prev || lastAlertTs === null || now - lastAlertTs >= REALERT_MS;
    return { alert: due, alerted: true, lastAlertTs: due ? now : lastAlertTs };
  }
  const out = { alert: false, alerted: prev };
  if (lastAlertTs !== null) out.lastAlertTs = lastAlertTs;
  return out;
}

/** Log an `alive` line only on a transition into alive, or hourly. */
function shouldLogDecision(decision, state, now) {
  if (decision !== 'alive') return true;
  if (!state || state.lastLoggedDecision !== 'alive') return true;
  const last = typeof state.lastAliveLoggedTs === 'number' ? state.lastAliveLoggedTs : 0;
  return now - last >= ALIVE_HEARTBEAT_MS;
}

/** Pure: names of watchdog-*.log files strictly older than the retention window. */
function selectPrunableLogs(entries, now, maxAgeMs = LOG_RETENTION_MS) {
  return entries
    .filter((e) => /^watchdog-.*\.log$/.test(e.name) && now - e.mtimeMs > maxAgeMs)
    .map((e) => e.name);
}

function pruneOldLogs(dir, now = Date.now(), maxAgeMs = LOG_RETENTION_MS) {
  const removed = [];
  try {
    const entries = [];
    for (const name of fs.readdirSync(dir)) {
      if (!/^watchdog-.*\.log$/.test(name)) continue;
      try { entries.push({ name, mtimeMs: fs.statSync(path.join(dir, name)).mtimeMs }); } catch { /* raced */ }
    }
    for (const name of selectPrunableLogs(entries, now, maxAgeMs)) {
      try { fs.unlinkSync(path.join(dir, name)); removed.push(name); } catch { /* ignore */ }
    }
  } catch { /* dir absent */ }
  return removed;
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
  const lastEntry = readLastHeartbeat(schedulerPaths.heartbeatPath());
  const lastTs = typeof lastEntry?.ts === 'number' ? lastEntry.ts : null;
  const heartbeatAgeMs = lastTs !== null ? now - lastTs : null;
  const fresh = lastTs !== null && heartbeatAgeMs < DEFAULT_MAX_AGE_MS;
  const decision = fresh ? 'alive' : 'stale';

  const logEntry = { ts: now, decision, heartbeatAgeMs, maxAgeMs: DEFAULT_MAX_AGE_MS };
  const statePath = alertStatePath();
  const state = readAlertState(statePath);
  pruneOldLogs(schedulerPaths.watchdogLogsDir(), now);

  // Records the tick's outcome; alive lines are throttled via shouldLogDecision.
  const finish = (extra, outcome) => {
    const logIt = shouldLogDecision(decision, state, now);
    if (logIt) appendLog({ ...logEntry, ...extra });
    writeAlertState(statePath, {
      alerted: outcome.alerted,
      lastAlertTs: typeof outcome.lastAlertTs === 'number' ? outcome.lastAlertTs : undefined,
      lastLoggedDecision: logIt ? decision : state.lastLoggedDecision,
      lastAliveLoggedTs: logIt && decision === 'alive' ? now : state.lastAliveLoggedTs,
    });
  };

  if (fresh) {
    // Alive branch: do nothing that touches queue.json. Let the in-app
    // scheduler manage its own queue to avoid races.
    // Observability only: a fresh heartbeat with a dead dispatch chain is a
    // live process — never relaunch (would spawn a second app on top of it).
    const dispatchLiveness = evaluateDispatchLiveness(lastEntry, now);
    if (dispatchLiveness.dead) {
      appendAuditEvent('dispatch_dead_observed', { dispatch: lastEntry.dispatch, reason: dispatchLiveness.reason });
    }
    if (lastEntry.degraded !== true) {
      try {
        resetRelaunchState();
      } catch (e) {
        process.stderr.write(`[watchdog] relaunch state reset failed: ${e?.message}\n`);
      }
    }
    const history = await runHistoryFinalize();
    finish({ dispatchLiveness, history }, nextAlertState(state, { fresh: true, now }));
    process.exit(0);
  }

  // Stale branch: app is absent or not updating heartbeat. Relaunch it —
  // reconciliation and feedback sweep are scheduler.cjs's own job now (PRD 686).
  const relaunch = maybeRelaunchApp();
  const history = await runHistoryFinalize();

  const outcome = nextAlertState(state, { fresh: false, relaunch, now });
  if (outcome.alert) sendDesktopNotification(ALERT_TITLE, ALERT_BODY);
  finish({ relaunch, history }, outcome);
  process.exit(0);
}

if (require.main === module) {
  main().catch((e) => {
    process.stderr.write(`[watchdog] fatal: ${e?.message}\n`);
    process.exit(1);
  });
}

module.exports = {
  sendDesktopNotification,
  nextAlertState,
  shouldLogDecision,
  selectPrunableLogs,
  pruneOldLogs,
  ALIVE_HEARTBEAT_MS,
  LOG_RETENTION_MS,
};

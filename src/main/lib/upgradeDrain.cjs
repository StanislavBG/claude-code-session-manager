'use strict';

/**
 * upgradeDrain.cjs — restart as a REQUEST that drains first and never kills.
 *
 *   requestRestart()  → writes <schedulerHome>/restart-request.json (atomic).
 *   evaluateDrain()   → PURE state machine: none | pause | wait | restart | abort.
 *   scheduler.cjs     → runs it from the existing 60 s heartbeat interval (no
 *                       new driver) and owns the `drain` field on the machine
 *                       runtime file. `drain` is deliberately NOT `state.paused`:
 *                       a rate-limit pause can't overwrite it and the manual-clear
 *                       cooldown (isCooldownSuppressed) can't swallow it.
 *
 * Lifecycle: request → pause (drain.active) → wait (running/investigating rows
 * finish; nothing new dispatches) → restart (zero busy, checked inside a mutate
 * right before exit) | abort (deadline; retires the request, clears the drain).
 * The request is stamped drainCompletedAt before exit; the next boot clears a
 * leftover drain whose request is complete.
 *
 * A `restarting.json` marker with a bounded lifetime covers the deliberate exit
 * window so scripts/scheduler-watchdog.cjs does not relaunch a second instance.
 */

const fs = require('node:fs');
const path = require('node:path');
const schedulerPaths = require('./schedulerPaths.cjs');

// Observed max job run is 240 min; 4 h converts a stuck drain to an abort.
const DEFAULT_DRAIN_DEADLINE_MS = 4 * 60 * 60_000;
// Long enough for a cold `npx` resolve + boot, short enough that a failed
// relaunch is picked up by the watchdog again.
const RESTARTING_MARKER_TTL_MS = 5 * 60_000;

function writeJsonAtomicSync(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

function readJsonSafe(file) {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8'));
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}

// ---------- request file ----------

function readRestartRequest(file = schedulerPaths.restartRequestPath()) {
  return readJsonSafe(file);
}

/**
 * requestRestart({reason, requestedBy}) → the request written. Idempotent: an
 * already-pending (not completed) request is returned unchanged so a repeated
 * click or the auto trigger can never reset the drain deadline.
 */
function requestRestart({ reason, requestedBy } = {}, { file = schedulerPaths.restartRequestPath(), now = Date.now() } = {}) {
  const existing = readRestartRequest(file);
  if (existing && !existing.drainCompletedAt) return existing;
  const request = {
    reason: typeof reason === 'string' && reason ? reason : 'unspecified',
    requestedBy: typeof requestedBy === 'string' && requestedBy ? requestedBy : 'unknown',
    requestedAt: new Date(now).toISOString(),
  };
  writeJsonAtomicSync(file, request);
  return request;
}

/** Stamp drainCompletedAt (called immediately before exit). */
function stampDrainCompleted(now = Date.now(), file = schedulerPaths.restartRequestPath()) {
  const existing = readRestartRequest(file);
  if (!existing) return null;
  const stamped = { ...existing, drainCompletedAt: new Date(now).toISOString() };
  writeJsonAtomicSync(file, stamped);
  return stamped;
}

function retireRestartRequest(file = schedulerPaths.restartRequestPath()) {
  try { fs.unlinkSync(file); } catch (e) { if (e?.code !== 'ENOENT') throw e; }
}

// ---------- pure state machine ----------

/**
 * queueBusyCount(jobs, extraInFlight?) → running + investigating rows, plus any
 * in-memory investigations the queue file cannot see.
 */
function queueBusyCount(jobs, extraInFlight = 0) {
  let n = 0;
  for (const j of Array.isArray(jobs) ? jobs : []) {
    if (j && (j.status === 'running' || j.status === 'investigating')) n++;
  }
  return n + (Number.isFinite(extraInFlight) ? extraInFlight : 0);
}

/**
 * evaluateDrain({request, queueSnapshot, drainState, now, deadlineMs}) → {action, reason}
 *
 * queueSnapshot: { running, investigating } counts (in-memory investigations
 * already folded in by the caller). drainState: the machine `drain` field
 * (null / {active}). Pure — no IO, no clock.
 *
 *   no request, or request already completed     → none   (abort if a stale drain is still active)
 *   deadline passed                              → abort
 *   request pending, drain not yet active        → pause  (engage drain)
 *   drain active, anything running/investigating → wait
 *   drain active, zero busy                      → restart
 */
function evaluateDrain({ request, queueSnapshot, drainState, now, deadlineMs = DEFAULT_DRAIN_DEADLINE_MS } = {}) {
  const active = Boolean(drainState && drainState.active);
  if (!request || request.drainCompletedAt) {
    return active && !request
      ? { action: 'abort', reason: 'drain-without-request' }
      : { action: 'none', reason: request ? 'request-complete' : 'no-request' };
  }
  const requestedMs = Date.parse(request.requestedAt ?? '');
  if (Number.isFinite(requestedMs) && now - requestedMs >= deadlineMs) {
    return { action: 'abort', reason: 'deadline' };
  }
  if (!active) return { action: 'pause', reason: 'engage' };
  const busy = (queueSnapshot?.running ?? 0) + (queueSnapshot?.investigating ?? 0);
  return busy > 0 ? { action: 'wait', reason: `busy:${busy}` } : { action: 'restart', reason: 'idle' };
}

/**
 * bootDrainAction({drainState, request}) → 'clear' | 'keep' | 'none'.
 * A drain whose request is complete (the restart happened) or gone is stale.
 */
function bootDrainAction({ drainState, request } = {}) {
  if (!drainState || !drainState.active) return 'none';
  if (!request || request.drainCompletedAt) return 'clear';
  return 'keep';
}

/** The pause-like view every dispatch classifier must use: paused OR draining. */
function effectivePaused(state) {
  if (state?.paused) return state.paused;
  return state?.drain?.active ? { reason: 'drain-for-upgrade' } : null;
}

// ---------- automatic trigger ----------

/**
 * installedBuildDiffers({running, installed}) — true only when BOTH shas are
 * known and differ (an install/update already happened). Never consults npm.
 */
function installedBuildDiffers({ running, installed } = {}) {
  return typeof running === 'string' && running !== ''
    && typeof installed === 'string' && installed !== ''
    && running !== installed;
}

// ---------- restarting marker (watchdog) ----------

function markRestarting({ file = schedulerPaths.restartingMarkerPath(), now = Date.now(), ttlMs = RESTARTING_MARKER_TTL_MS } = {}) {
  writeJsonAtomicSync(file, { pid: process.pid, at: now, expiresAt: now + ttlMs });
}

function clearRestartingMarker(file = schedulerPaths.restartingMarkerPath()) {
  try { fs.unlinkSync(file); } catch { /* absent */ }
}

/** True while the marker exists and has not expired (bounded lifetime). */
function isRestartingMarkerActive({ file = schedulerPaths.restartingMarkerPath(), now = Date.now() } = {}) {
  const m = readJsonSafe(file);
  return Boolean(m) && typeof m.expiresAt === 'number' && now < m.expiresAt;
}

module.exports = {
  DEFAULT_DRAIN_DEADLINE_MS,
  RESTARTING_MARKER_TTL_MS,
  readRestartRequest,
  requestRestart,
  stampDrainCompleted,
  retireRestartRequest,
  queueBusyCount,
  evaluateDrain,
  bootDrainAction,
  effectivePaused,
  installedBuildDiffers,
  markRestarting,
  clearRestartingMarker,
  isRestartingMarkerActive,
};

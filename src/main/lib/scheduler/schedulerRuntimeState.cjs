/**
 * schedulerRuntimeState.cjs — process-local runtime reservations that used to
 * be bare ++/-- counters in scheduler.cjs. The auto-fix investigation cap is
 * now a Map of slug → { claimedAt, pid } so a reservation stranded by a
 * promise that never settles can be expired when its owner is provably dead
 * (reservationExpiry.isProvablyDead), instead of shrinking the cap forever.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { readJsonOrSync, writeJsonAtomicSync } = require('../util/atomicFs.cjs');
const { appendAuditEvent } = require('../telemetry/auditLog.cjs');
const { isProvablyDead, DEFAULT_GRACE_MS } = require('./reservationExpiry.cjs');

const investigations = new Map(); // slug -> { claimedAt, pid }

/*
 * Persisted machine runtime state (survives restarts), unlike the
 * process-local reservations above: <schedulerHome>/scheduler-runtime-state.json.
 * Today it holds one key, `environmentReportSince` — epoch ms of the first
 * time environment enforcement was evaluated on this machine. The report-only
 * week (schedulerConfig.environmentEnforcement) is measured from it. Written
 * once, atomically, and never reset: a restart re-reads the same value.
 */
const RUNTIME_STATE_FILE = 'scheduler-runtime-state.json';

function runtimeStatePath() {
  const { schedulerHome } = require('./schedulerPaths.cjs');
  return path.join(schedulerHome(), RUNTIME_STATE_FILE);
}

/** @type {Map<string, number>} statePath -> environmentReportSince (memo; the value never changes once written) */
const reportSinceMemo = new Map();

function validStamp(v) {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;
}

/**
 * The persisted environmentReportSince (epoch ms), writing `now` first if no
 * valid value is on disk yet. Never overwrites an existing value. Throws only
 * if the state file cannot be written.
 * @param {{ now?: number, statePath?: string }} [opts]
 * @returns {number}
 */
function ensureEnvironmentReportSince({ now = Date.now(), statePath = runtimeStatePath() } = {}) {
  const memo = reportSinceMemo.get(statePath);
  if (memo) return memo;
  const state = readJsonOrSync(statePath, null);
  const obj = state && typeof state === 'object' && !Array.isArray(state) ? state : {};
  let since = validStamp(obj.environmentReportSince);
  if (!since) {
    since = now;
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    writeJsonAtomicSync(statePath, { ...obj, environmentReportSince: since });
  }
  reportSinceMemo.set(statePath, since);
  return since;
}

function investigationCount() { return investigations.size; }

/** reserveInvestigation(slug) — false if already reserved. Cap checks stay with the caller. */
function reserveInvestigation(slug, { claimedAt = Date.now() } = {}) {
  const key = String(slug);
  if (investigations.has(key)) return false;
  investigations.set(key, { claimedAt, pid: null });
  return true;
}

function stampInvestigationPid(slug, pid) {
  const r = investigations.get(String(slug));
  if (!r || !Number.isInteger(pid) || pid <= 0) return false;
  r.pid = pid;
  return true;
}

/** releaseInvestigation — idempotent; returns whether a reservation was removed. */
function releaseInvestigation(slug) {
  return investigations.delete(String(slug));
}

/** Expire investigations whose slug has no `investigating` row and whose owner is provably dead. */
function expireDeadInvestigations({ liveSlugs, pidAlive, now = Date.now(), graceMs = DEFAULT_GRACE_MS } = {}) {
  const live = liveSlugs instanceof Set ? liveSlugs : new Set(liveSlugs || []);
  const expired = [];
  for (const [slug, r] of [...investigations]) {
    if (!isProvablyDead(r, { live: live.has(slug), pidAlive, now, graceMs })) continue;
    investigations.delete(slug);
    expired.push(slug);
    appendAuditEvent('investigation_reservation_expired', { slug, pid: r.pid });
  }
  return expired;
}

function __resetForTests() { investigations.clear(); reportSinceMemo.clear(); }

module.exports = {
  investigationCount,
  reserveInvestigation,
  stampInvestigationPid,
  releaseInvestigation,
  expireDeadInvestigations,
  runtimeStatePath,
  ensureEnvironmentReportSince,
  __resetForTests,
};

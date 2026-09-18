/**
 * schedulerRuntimeState.cjs — process-local runtime reservations that used to
 * be bare ++/-- counters in scheduler.cjs. The auto-fix investigation cap is
 * now a Map of slug → { claimedAt, pid } so a reservation stranded by a
 * promise that never settles can be expired when its owner is provably dead
 * (reservationExpiry.isProvablyDead), instead of shrinking the cap forever.
 */
'use strict';

const { appendAuditEvent } = require('./auditLog.cjs');
const { isProvablyDead, DEFAULT_GRACE_MS } = require('./reservationExpiry.cjs');

const investigations = new Map(); // slug -> { claimedAt, pid }

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

function __resetForTests() { investigations.clear(); }

module.exports = {
  investigationCount,
  reserveInvestigation,
  stampInvestigationPid,
  releaseInvestigation,
  expireDeadInvestigations,
  __resetForTests,
};

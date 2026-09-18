/**
 * quietMachineLease.cjs — the exclusive, machine-wide dispatch lock a
 * `quietMachine: true` PRD holds for the duration of its run (PRD 1107).
 *
 * Process-local, like sessionSlots.cjs's holder map — reset on restart by
 * design; a crashed lease must never wedge the queue permanently. This is
 * NOT a second concurrency pool: sessionSlots.cjs remains the sole slot
 * pool. This module only answers "is a quiet-machine job currently running,
 * and if so, hold every other dispatch until it releases?" — schedulerBatch
 * .cjs's pickNextBatch reads isHeld() to gate the WHOLE tick, not just one
 * project.
 */
'use strict';

const { appendAuditEvent } = require('./auditLog.cjs');
const { isProvablyDead, DEFAULT_GRACE_MS } = require('./reservationExpiry.cjs');

// slug of the job currently holding the lease, or null.
let heldBySlug = null;
let heldClaimedAt = 0;

function isHeld() {
  return heldBySlug !== null;
}

/** acquire(slug) → true if the lease was free and is now held by `slug`. */
function acquire(slug, { claimedAt = Date.now() } = {}) {
  if (heldBySlug !== null) return false;
  heldBySlug = String(slug);
  heldClaimedAt = claimedAt;
  return true;
}

/** release(slug) — idempotent; releasing when not held, or held by a
 * different slug, is a no-op (mirrors sessionSlots.release's tolerance for
 * an already-released token). */
function release(slug) {
  if (heldBySlug === null) return false;
  if (heldBySlug !== String(slug)) return false;
  heldBySlug = null;
  return true;
}

/** expireDead — free a lease whose holder has no running row and is past the grace window
 * (the lease never carries a pid; the row-liveness + grace proof is the whole test). */
function expireDead({ liveSlugs, now = Date.now(), graceMs = DEFAULT_GRACE_MS } = {}) {
  if (heldBySlug === null) return false;
  const live = liveSlugs instanceof Set ? liveSlugs : new Set(liveSlugs || []);
  if (!isProvablyDead({ claimedAt: heldClaimedAt, pid: null }, { live: live.has(heldBySlug), now, graceMs })) return false;
  appendAuditEvent('quiet_lease_expired', { slug: heldBySlug });
  heldBySlug = null;
  return true;
}

function holder() {
  return heldBySlug;
}

/** Test hook: force the lease back to free. */
function __resetForTests() {
  heldBySlug = null;
  heldClaimedAt = 0;
}

module.exports = { isHeld, acquire, release, expireDead, holder, __resetForTests };

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

// slug of the job currently holding the lease, or null.
let heldBySlug = null;

function isHeld() {
  return heldBySlug !== null;
}

/** acquire(slug) → true if the lease was free and is now held by `slug`. */
function acquire(slug) {
  if (heldBySlug !== null) return false;
  heldBySlug = String(slug);
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

function holder() {
  return heldBySlug;
}

/** Test hook: force the lease back to free. */
function __resetForTests() {
  heldBySlug = null;
}

module.exports = { isHeld, acquire, release, holder, __resetForTests };

/**
 * scheduleJobTransitions.cjs — the ONE place a ScheduleJob's `status` field
 * is assigned, mirroring epicMint.cjs's fail-closed ownership of the Epic's
 * `proposed -> active` transition.
 *
 * Before this module, `j.status = '...'` was a bare mutation at 16 separate
 * sites in scheduler.cjs — no legality table, no record of who changed a
 * status or why. That is why the 1021/1022 stall (2026-08-07) was
 * undiagnosable from the app: the only evidence was a heartbeat count, not a
 * trace of what the job's status actually did over time.
 *
 * `transitionJob(job, toStatus, { reason, source })` is the chokepoint:
 *  - Looks up `job.status -> toStatus` in LEGAL_TRANSITIONS. An identity
 *    transition (status unchanged) is always accepted as a no-op — it never
 *    mutates statusHistory or writes an audit record, since nothing changed.
 *  - A legal transition mutates `job.status`, appends one bounded
 *    `statusHistory` entry, and appends one record to the existing
 *    ~/.claude/session-manager/audit-log.jsonl via auditLog.cjs (the same
 *    writer epicMint.cjs already uses for `epic_mint`/`epic_mint_refused` —
 *    deliberately not a second log file).
 *  - An illegal transition is refused: the job is left untouched, an
 *    error-level line is logged, a refusal counter increments, and a
 *    `job_transition_refused` audit record is written. It never throws —
 *    scheduler.cjs's tickQueue must keep running even if a call site asks
 *    for an illegal edge (same non-blocking posture as dodDrainHook.cjs).
 *
 * Plain Node module (no Electron deps), like scheduleJobSchema.cjs and
 * epicMint.cjs, so it stays requirable from watchdog scripts outside
 * Electron.
 */
'use strict';

const { appendAuditEvent } = require('./auditLog.cjs');

// Bounded so queue.json (mutation cost, broadcast payload, pickNextBatch
// scan) stays small — same rationale as lib/queueHistory.cjs's retention
// window.
const STATUS_HISTORY_CAP = 20;

/**
 * Explicit from->to edges. Every real assignment site in scheduler.cjs maps
 * onto one of these (verified against the 16 sites this module replaces):
 *  - pending->running (dispatch), pending->completed (archived-PRD skip,
 *    manual archive of an already-shipped PRD), pending->failed (admin
 *    cancelJob on a not-yet-started job)
 *  - running->completed|failed|needs_review (normal run outcomes, reaper),
 *    running->pending (halt/rate-limit reset, transient-failure retry)
 *  - investigating->failed|needs_review (restore prior status once the
 *    investigation probe exits), investigating->completed (defensive: the
 *    restored prior status could in principle be 'completed' if a caller
 *    ever marks investigating on a completed job), investigating->pending
 *    (admin reset can target a job mid-investigation)
 *  - failed->investigating (spawn a probe), failed->pending (admin reset /
 *    transient retry), failed->completed (auto-promote a fix-plan's healed
 *    original)
 *  - needs_review->investigating, needs_review->pending, needs_review->completed
 *    (heal on reverify, or auto-promote) — same shape as `failed`
 *  - completed->pending (force-only reset, gated separately by
 *    resetJobFields' own guard — this table only says the edge is
 *    structurally legal, not that every caller may take it unconditionally)
 */
const LEGAL_TRANSITIONS = {
  pending: ['running', 'completed', 'failed'],
  running: ['completed', 'failed', 'needs_review', 'pending'],
  investigating: ['failed', 'needs_review', 'completed', 'pending'],
  failed: ['investigating', 'pending', 'completed'],
  needs_review: ['investigating', 'pending', 'completed'],
  completed: ['pending'],
};

let refusedTransitionCount = 0;

function isLegalTransition(from, to) {
  if (from === to) return true;
  const edges = LEGAL_TRANSITIONS[from];
  return Array.isArray(edges) && edges.includes(to);
}

/**
 * transitionJob(job, toStatus, { reason, source }) → boolean
 *
 * Mutates `job` in place on success. `reason` and `source` are free-text
 * (why this transition is happening, and which call site requested it) —
 * both are required in spirit (every call site in scheduler.cjs passes real
 * strings) but not enforced here, since a missing reason/source is a lesser
 * sin than a call this function refuses outright.
 */
function transitionJob(job, toStatus, { reason, source, allowAnyFrom = false } = {}) {
  if (!job || typeof job !== 'object') return false;
  const from = job.status;

  // `allowAnyFrom` is a narrow escape hatch for repairing a row whose
  // persisted `status` was never a legal value to begin with (e.g. the
  // 1021/1022 incident's `"status": "queued"`, quarantined by
  // scheduleJobSchema.cjs and repaired by reconcile()'s invalid-row pass).
  // That is a data repair, not a lifecycle transition — there is no legal
  // predecessor to check `from` against — so it still goes through this
  // chokepoint (mutation, statusHistory, audit) without consulting
  // LEGAL_TRANSITIONS. Every other caller leaves this false.
  if (!allowAnyFrom && !isLegalTransition(from, toStatus)) {
    refusedTransitionCount += 1;
    console.error(
      `[scheduleJobTransitions] illegal transition refused: slug=${job.slug ?? '(unknown)'} `
      + `from=${from ?? '(none)'} to=${toStatus ?? '(none)'} reason=${reason ?? '(none)'} source=${source ?? '(none)'}`,
    );
    appendAuditEvent('job_transition_refused', {
      slug: job.slug ?? null,
      from: from ?? null,
      to: toStatus ?? null,
      reason: reason ?? null,
      source: source ?? null,
      cwd: job.cwd ?? null,
    });
    return false;
  }

  if (from === toStatus) return true; // identity — nothing changed, nothing to record

  job.status = toStatus;
  const entry = {
    from: from ?? null,
    to: toStatus,
    reason: reason ?? null,
    source: source ?? null,
    at: new Date().toISOString(),
  };
  const history = Array.isArray(job.statusHistory) ? job.statusHistory : [];
  history.push(entry);
  while (history.length > STATUS_HISTORY_CAP) history.shift();
  job.statusHistory = history;

  appendAuditEvent('job_transition', {
    slug: job.slug ?? null,
    from: from ?? null,
    to: toStatus,
    reason: reason ?? null,
    source: source ?? null,
    cwd: job.cwd ?? null,
  });
  return true;
}

function getRefusedTransitionCount() {
  return refusedTransitionCount;
}

// Test-only: reset the module-level refusal counter between test cases.
function _resetRefusedTransitionCountForTests() {
  refusedTransitionCount = 0;
}

module.exports = {
  transitionJob,
  LEGAL_TRANSITIONS,
  STATUS_HISTORY_CAP,
  getRefusedTransitionCount,
  _resetRefusedTransitionCountForTests,
};

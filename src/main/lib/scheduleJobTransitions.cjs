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
const telemetryCounters = require('./telemetryCounters.cjs');
const queueHistory = require('./queueHistory.cjs');
const { buildNeedsReviewEntryLine, buildNeedsReviewResolutionLine } = require('./needsReviewLedger.cjs');

// A run genuinely finished when it leaves 'running' for one of these —
// distinct from every other legal edge in LEGAL_TRANSITIONS (retries,
// investigation probes, admin resets), which don't represent a completed
// execution attempt.
const FINISH_STATUSES = new Set(['completed', 'failed', 'skipped', 'needs_review']);

// Bounded so queue.json (mutation cost, broadcast payload, pickNextBatch
// scan) stays small — same rationale as lib/queueHistory.cjs's retention
// window.
const STATUS_HISTORY_CAP = 20;

/**
 * Explicit from->to edges. Every real assignment site in scheduler.cjs maps
 * onto one of these (verified against the 16 sites this module replaces):
 *  - pending->running (dispatch), pending->completed (archived-PRD skip,
 *    manual archive of an already-shipped PRD; also source
 *    'spawnJob:dispatch-sidecar-reconcile' — a pending row about to
 *    dispatch whose newest run-sidecar already shows a completed-equivalent
 *    outcome finished at/after this row's own last pending transition is
 *    finalized from that sidecar instead of spawning a redundant re-run;
 *    2026-09-06 incident: a silently-dropped finalize left a slug 'pending'
 *    forever and the dispatcher re-fired it three times), pending->failed
 *    (admin cancelJob on a not-yet-started job)
 *  - running->completed|failed|needs_review (normal run outcomes, reaper),
 *    running->skipped (spawnJob:skip-archived's 'prd-missing' case — no
 *    executor ever ran; kept distinct from 'completed' so unrun work can't
 *    read as shipped), running->pending (halt/rate-limit reset,
 *    transient-failure retry). Also reached with verdict
 *    'reaped_without_integration' (source 'reapDeadRunningJobs', PRD 1133): a
 *    reaped job whose result event looked successful but whose work cannot
 *    be shown to have landed — a worktree branch still holding unmerged
 *    commits, or an in-place run whose HEAD never advanced during the run
 *    window — is parked here instead of 'completed', naming the branch (or
 *    the lack of any commit) so the stranded work is never silently treated
 *    as shipped.
 *  - investigating->failed|needs_review (restore prior status once the
 *    investigation probe exits), investigating->completed (defensive: the
 *    restored prior status could in principle be 'completed' if a caller
 *    ever marks investigating on a completed job), investigating->pending
 *    (admin reset can target a job mid-investigation)
 *  - failed->investigating (spawn a probe), failed->pending (admin reset /
 *    transient retry), failed->completed (auto-promote a fix-plan's healed
 *    original), failed->needs_review (reverifyNeedsReview's looksDone pass,
 *    PRD 1102: an unverified-shaped failed row — no sentinel, no result
 *    event — with a commit landed after its run window that touches its own
 *    declared paths is surfaced to a human as needs_review, never silently
 *    auto-completed)
 *  - needs_review->investigating, needs_review->pending, needs_review->completed
 *    (heal on reverify, or auto-promote) — same shape as `failed`. Also
 *    reached by source 'scheduler:mechanicalRecovery' (PRD 1130): a job
 *    parked with a mechanically-resolvable verdict (starting with exactly
 *    'worktree_integration_failed') gets one bounded, model-free re-attempt
 *    of its worktree branch integration; success lands here exactly like any
 *    other completion.
 *  - needs_review->running (resume-first recovery, PRD 1111: a job parked
 *    needs_review with verdict 'uncommitted_changes' gets one bounded
 *    `claude -p --resume` dispatch through spawnJob before any fix-plan
 *    investigation is authored — spawnJob's own dispatch mutate transitions
 *    straight to 'running', same as any pending job)
 *  - completed->pending (force-only reset, gated separately by
 *    resetJobFields' own guard — this table only says the edge is
 *    structurally legal, not that every caller may take it unconditionally)
 *  - skipped->pending (force-only reset, same resetJobFields guard as
 *    completed->pending — 'skipped' is otherwise terminal: no further
 *    transitions out)
 *  - quarantined->pending (reconcile()'s adopt path, PRD-authoring lockdown:
 *    a PRD discovered with no `createdVia` provenance stamp is queued
 *    'quarantined' instead of 'pending'; the ONLY way out is the PRD being
 *    stamped via the update-prd API — reconcile() detects the stamp on its
 *    next pass and promotes the row)
 *  - pending|investigating|needs_review|quarantined -> skipped
 *    (schedule:clear-queue: a manual queue clear force-terminates any
 *    non-running victim row so it can leave a durable history.jsonl record
 *    instead of vanishing — same 'never ran, don't call it completed'
 *    rationale as running->skipped, just reachable from every pre-dispatch
 *    or unresolved status a queued row can be sitting in)
 */
const LEGAL_TRANSITIONS = {
  pending: ['running', 'completed', 'failed', 'skipped'],
  running: ['completed', 'failed', 'needs_review', 'skipped', 'pending'],
  investigating: ['failed', 'needs_review', 'completed', 'pending', 'skipped'],
  failed: ['investigating', 'pending', 'completed', 'needs_review'],
  needs_review: ['investigating', 'pending', 'completed', 'skipped', 'running'],
  completed: ['pending'],
  skipped: ['pending'],
  quarantined: ['pending', 'skipped'],
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

  if (from === 'running' && FINISH_STATUSES.has(toStatus)) {
    telemetryCounters.trackSchedulerJobFinish({ status: toStatus });
  }

  // needs_review ledger (PRD: needs_review durability). This IS the single
  // funnel every needs_review transition — entry or resolution — passes
  // through (see this file's own header comment: transitionJob is the ONE
  // place `status` is assigned), so hooking here, rather than any one of
  // needs_review's several distinct entry call sites in scheduler.cjs,
  // guarantees no path can bypass it.
  //
  // Fire-and-forget, exactly like every other best-effort side-channel write
  // in this codebase (rcaReport.cjs, auditLog.cjs's own posture) — a ledger
  // write failure must never fail or delay the transition it's recording.
  // 'investigating' is a PAUSE, not a resolution, when it's reached FROM
  // needs_review: spawnInvestigation always restores the job to exactly the
  // status it left (a snapshot taken before the pause), so
  // needs_review -> investigating -> needs_review is one continuous episode,
  // not two. Without this check, the pause mints a spurious 'auto-fix'
  // resolution mid-episode, then the resume mints a spurious fresh entry
  // that overwrites the original episode's runId/enteredAt/reason in the
  // ledger's by-key maps (keyed on slug+runId) — corrupting byLadderRung and
  // understating dwell time. Detected via the stamped episode fields
  // themselves rather than the transition's source string, since the same
  // 'investigating' status is also reached fresh from 'failed' (a job that
  // was never parked needs_review at all, and has no episode to pause).
  const isNeedsReviewPause = from === 'needs_review' && toStatus === 'investigating';
  const pausedEpisodeOpen = job.needsReviewEntryRunId !== undefined;
  const isNeedsReviewResume = from === 'investigating' && pausedEpisodeOpen;

  if (toStatus === 'needs_review' && from !== 'needs_review' && !isNeedsReviewResume) {
    // ENTRY: stamp the episode's runId/enteredAt on the job itself so the
    // RESOLUTION line (below) can reference the SAME runId even if the job's
    // own `runId` is reassigned in between (e.g. a resume-recovery
    // re-dispatch mints a fresh one before this episode resolves).
    job.needsReviewEntryRunId = job.runId ?? null;
    job.needsReviewEnteredAt = entry.at;
    queueHistory.appendHistory([buildNeedsReviewEntryLine(job, entry)]).catch((e) => {
      console.error('[scheduleJobTransitions] failed to append needs_review entry', e?.message ?? String(e));
    });
  } else if (
    (from === 'needs_review' && toStatus !== 'needs_review' && !isNeedsReviewPause)
    || (isNeedsReviewResume && toStatus !== 'needs_review')
  ) {
    // RESOLUTION: read the episode stamped at entry, then clear it — the
    // episode is over regardless of what this resolution line looks like.
    // The `isNeedsReviewResume` arm covers an episode that paused for
    // investigation and is now resolving to something other than
    // needs_review (e.g. the investigation actually fixed it) — the episode
    // stamps were deliberately left untouched across the pause, so this
    // still references the ORIGINAL entry time, not the pause's.
    const episode = { runId: job.needsReviewEntryRunId ?? null, enteredAt: job.needsReviewEnteredAt ?? null };
    delete job.needsReviewEntryRunId;
    delete job.needsReviewEnteredAt;
    queueHistory.appendHistory([buildNeedsReviewResolutionLine(job, entry, episode)]).catch((e) => {
      console.error('[scheduleJobTransitions] failed to append needs_review resolution', e?.message ?? String(e));
    });
  }
  // else: isNeedsReviewPause (needs_review -> investigating), or
  // isNeedsReviewResume && toStatus === 'needs_review' (investigating ->
  // needs_review, still the same open episode) — intentionally a no-op.

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

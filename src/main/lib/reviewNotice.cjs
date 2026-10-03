'use strict';

/**
 * reviewNotice.cjs — pure helpers behind the quiet, grouped needs_review
 * notice (this PRD).
 *
 * Before this module, a park into `needs_review` told the authoring Epic
 * immediately (scheduler.cjs's notifyNeedsReview), BEFORE the scheduler's own
 * recovery ladder (mechanical re-integration, resume, quarantine, auto-fix,
 * gate re-run, bounded auto-resolve) ever got a chance to run. Most parks
 * heal on their own, so that immediate message was usually a false alarm.
 *
 * The new rule: record a notice at park time (buildReviewNotice) and send
 * nothing yet. Send ONE message, grouped by (cwd, Epic, cause), only once the
 * ladder gives up on a row (an auto-resolve skip) or the row has sat
 * `needs_review` past a hold window (selectDueReviewNotices + holdMsFromEnv).
 * scheduler.cjs's flushDueReviewNotices is the only caller that actually
 * sends — this module stays fs/network-free so it is unit-testable without
 * touching queue.json or the Epic event store.
 *
 * Each park is one episode with one hold clock. scheduler.cjs's
 * resetJobFields deletes `job.reviewNotice` outright, so a human reset always
 * starts the next park's clock fresh — it never inherits a stale
 * `firstParkedAt` from days earlier. A rung-6 ladder requeue goes through
 * `transitionJob` directly, not `resetJobFields`, so that requeue keeps the
 * same clock on purpose (it is still the same unresolved episode).
 *
 * The sent message also says plainly whether the group still blocks other
 * work: formatReviewNotice names any `pending` row whose `dependsOn` names a
 * still-`needs_review` row in the group, instead of always claiming nothing
 * is waiting. And a row that is not yet due on its own only joins a due
 * group — "sweeps in" — once it has sat for SWEEP_MIN_AGE_MINUTES, so a row
 * that parked seconds ago is never announced before the ladder's early rungs
 * get a chance to run.
 */

// Default hold before an un-resolved needs_review park gets its own grouped
// notice, in minutes. Overridable via SM_REVIEW_NOTICE_HOLD_MINUTES.
const DEFAULT_HOLD_MINUTES = 240;

// Same dependsOn slug-matching rule schedulerBatch.cjs's findBlockingDep uses
// at run time (exact slug first, else bare-name after stripping one leading
// `NN-`) — reused here, not reimplemented, so formatReviewNotice's "blocks"
// wording can never disagree with what actually holds a dependent `pending`
// row in the real queue.
const { bareSlug } = require('./depSlugResolve.cjs');

/**
 * buildReviewNotice({ job, report, epicId, now, prior }) → ReviewNotice
 *
 * Stamped onto a job row (`job.reviewNotice`) the moment it parks
 * `needs_review`, in the SAME mutate that classifies the RCA report
 * (scheduler.cjs's park path). `report` is rcaReport.cjs's writeRcaReport()
 * result — `null`, or `{ filed: false, ... }` when the report was skipped
 * (SM_RCA_DISABLE, no verdict, etc.) — in which case a deterministic fallback
 * summary stands in for the one the RCA report would have carried.
 *
 * `firstParkedAt` is the anchor selectDueReviewNotices measures the hold
 * window from. It is carried forward from `prior` (the job's existing
 * reviewNotice, if any) as long as that prior notice is still unsent — a
 * re-park of the SAME unresolved episode (e.g. one more ladder attempt that
 * also fails) must not restart the hold clock. Once a notice has been sent,
 * a later park starts a fresh clock — and so does a later park after a human
 * reset, because resetJobFields deletes the notice outright, so `prior` is
 * `undefined` and this falls to the same `now` default.
 */
function buildReviewNotice({ job, report, epicId, now, prior } = {}) {
  const cause = `${job?.verifierVerdict || 'unknown'}${job?.integrationFailureKind ? `:${job.integrationFailureKind}` : ''}`;
  const filed = Boolean(report && report.filed);
  const summary = filed ? report.summary : `${job?.slug ?? 'unknown job'} stopped (${cause})`;
  const reportPath = filed ? (report.path ?? null) : null;
  const firstParkedAt = prior && !prior.sentAt && prior.firstParkedAt ? prior.firstParkedAt : now;
  return {
    summary,
    reportPath,
    cause,
    epicId: epicId ?? null,
    firstParkedAt,
    sentAt: null,
  };
}

// A not-yet-due row only joins a due group ("sweeps in") once it has sat
// `needs_review` for at least this long. Why: the self-heal ladder
// (scheduler-operations.md §4) needs about 30 minutes to work through its
// early rungs, so sweeping in a row seconds after it parked would announce
// it before the ladder ever got a chance to self-heal it. A row that is due
// ON ITS OWN (its own hold expired, or a skipped auto-resolve) is never held
// back by this rule — see isDue below.
const SWEEP_MIN_AGE_MINUTES = 30;

// Milliseconds since reviewNotice.firstParkedAt, or 0 for a missing/
// unparsable timestamp (fail young — never treat a bad timestamp as old
// enough to sweep in early).
function parkedAgeMs(j, now) {
  const firstParkedAt = j.reviewNotice && j.reviewNotice.firstParkedAt;
  if (!firstParkedAt) return 0;
  const parkedMs = Date.parse(firstParkedAt);
  return Number.isFinite(parkedMs) ? now - parkedMs : 0;
}

/**
 * selectDueReviewNotices(jobs, { now, holdMs }) → [{ cwd, epicId, cause, jobs }]
 *
 * A row is a candidate when it carries an unsent `reviewNotice` and is
 * either `skipped` with `needsReviewAutoResolvedSkip` (the ladder gave up),
 * or still `needs_review` with its notice's `firstParkedAt` at least
 * `holdMs` in the past. completed/pending/running rows, and rows whose
 * notice is already sent, are never candidates.
 *
 * Grouping key is (cwd, reviewNotice.epicId, reviewNotice.cause) — one
 * message per distinct cause per Epic, not one per PRD. Once any row in a
 * key is due, every other unsent candidate sharing that same key is swept
 * into the SAME group even if it individually hasn't reached its own due
 * condition yet, so a cause that affects several PRDs is reported once —
 * except a swept-in `needs_review` row must itself be at least
 * SWEEP_MIN_AGE_MINUTES old (parkedAgeMs); a row due on its own skips that
 * check entirely.
 */
function selectDueReviewNotices(jobs = [], { now = Date.now(), holdMs = DEFAULT_HOLD_MINUTES * 60000 } = {}) {
  const isCandidate = (j) => Boolean(
    j
    && j.reviewNotice
    && !j.reviewNotice.sentAt
    && (j.status === 'needs_review' || (j.status === 'skipped' && j.needsReviewAutoResolvedSkip)),
  );
  const isDue = (j) => {
    if (j.status === 'skipped' && j.needsReviewAutoResolvedSkip) return true;
    if (j.status !== 'needs_review') return false;
    const firstParkedAt = j.reviewNotice.firstParkedAt;
    if (!firstParkedAt) return false;
    const parkedMs = Date.parse(firstParkedAt);
    if (!Number.isFinite(parkedMs)) return false;
    return now - parkedMs >= holdMs;
  };
  const keyOf = (j) => `${j.cwd ?? ''}\u0000${j.reviewNotice.epicId ?? ''}\u0000${j.reviewNotice.cause ?? ''}`;

  const list = Array.isArray(jobs) ? jobs : [];
  const dueKeys = new Set();
  for (const j of list) {
    if (isCandidate(j) && isDue(j)) dueKeys.add(keyOf(j));
  }
  if (dueKeys.size === 0) return [];

  const sweepMinAgeMs = SWEEP_MIN_AGE_MINUTES * 60000;
  const groupsByKey = new Map();
  for (const j of list) {
    if (!isCandidate(j)) continue;
    const key = keyOf(j);
    if (!dueKeys.has(key)) continue;
    // Not due on its own, and too young to sweep in — leave it for a later
    // pass, once either its own hold expires or it ages past the sweep gate.
    if (!isDue(j) && parkedAgeMs(j, now) < sweepMinAgeMs) continue;
    if (!groupsByKey.has(key)) {
      groupsByKey.set(key, { cwd: j.cwd ?? null, epicId: j.reviewNotice.epicId ?? null, cause: j.reviewNotice.cause ?? null, jobs: [] });
    }
    groupsByKey.get(key).jobs.push(j);
  }
  return Array.from(groupsByKey.values());
}

// Plain-language stand-in for the raw verifier/integration cause string.
// Only causes worth explaining in human terms get an entry — formatReviewNotice
// falls back to the raw cause for anything not listed here.
const HUMAN_CAUSE = {
  'worktree_integration_failed:stray_checkout': 'the main checkout was on a different branch, so the work could not be merged',
  transcript_errors: "the run's transcript showed error lines, so its pass could not be trusted",
  no_verdict_sentinel: 'the run finished without leaving a clear pass or fail signal',
  abandoned_background_task: 'the run started a background task and then stopped watching it',
  silent_no_op: 'the run finished clean but made no changes, so there is no evidence it did the work',
  pass_no_commit: 'the run reported success but did not commit anything',
};

function humanCauseFor(cause) {
  return HUMAN_CAUSE[cause] ?? cause;
}

// One phrase per ladder rung, in the fixed order the ladder itself runs
// (scheduler-operations.md §4). Checked across every row in the group — the
// summary is the union of what was tried for ANY of the grouped PRDs, not
// just one.
function ladderSummaryFor(jobs) {
  const some = (pred) => jobs.some(pred);
  const phrases = [];
  if (some((j) => j.mechanicalRecoveryAttempted)) phrases.push('re-merged the branch');
  if (some((j) => j.resumeRecoveryAttempted)) phrases.push('resumed the session');
  if (some((j) => (j.quarantineResolveAttempts ?? 0) > 0)) phrases.push('set aside stray files');
  if (some((j) => j.autoFixAttempted)) phrases.push('ran an auto-fix job');
  if (some((j) => j.gateShadow)) phrases.push('re-ran the gate');
  if (some((j) => (j.exhaustedResolveAttempts ?? 0) > 0)) phrases.push('re-queued the job');
  if (some((j) => j.needsReviewAutoResolvedSkip)) phrases.push('gave up and skipped the job');
  return phrases.length ? phrases.join(', ') : 'nothing yet';
}

// The pending rows (from the FULL job list, not just this group) that a
// still-`needs_review` row in the group blocks. A dep slug "names" a group
// row when it matches that row's slug exactly, or by bare name (same rule as
// findBlockingDep). Only rows in the group's own cwd are considered — a
// dependsOn chain never crosses projects. Returns a sorted, de-duplicated
// list of the blocked rows' slugs.
function blockedDependents(group, jobs) {
  const blockingSlugs = (group.jobs ?? [])
    .filter((j) => j.status === 'needs_review')
    .map((j) => j.slug)
    .filter(Boolean);
  if (!blockingSlugs.length) return [];
  const namesABlockingSlug = (depSlug) => blockingSlugs.some(
    (slug) => depSlug === slug || bareSlug(depSlug) === bareSlug(slug),
  );
  const blocked = new Set();
  for (const p of jobs ?? []) {
    if (p.status !== 'pending' || p.cwd !== group.cwd) continue;
    if ((p.dependsOn ?? []).some(namesABlockingSlug)) blocked.add(p.slug);
  }
  return [...blocked].sort();
}

/**
 * formatReviewNotice(group, { jobs }) → plain-text message body for the
 * authoring Epic's event chain. `group` is one entry from
 * selectDueReviewNotices(). `jobs` is the FULL live job list (every status,
 * every project) — needed to find any `pending` row this group still blocks;
 * omit it (or pass `[]`) to always get the "nothing is waiting" wording,
 * e.g. from a caller that only has the group itself.
 */
function formatReviewNotice(group, { jobs = [] } = {}) {
  const groupJobs = group.jobs ?? [];
  const slugs = groupJobs.map((j) => j.slug).filter(Boolean);
  const reportPaths = groupJobs.map((j) => j.reviewNotice?.reportPath).filter(Boolean);
  const blocked = blockedDependents(group, jobs);
  const waitingLine = blocked.length
    ? `These PRDs block ${blocked.length} other PRD(s) until they are fixed, reset or archived: ${blocked.join(', ')}.`
    : 'The rest of the plan keeps running. Nothing is waiting on you unless you want to act.';
  const lines = [
    `${groupJobs.length} PRD(s) stopped for the same reason: ${humanCauseFor(group.cause)}.`,
    `The scheduler already tried to fix this on its own: ${ladderSummaryFor(groupJobs)}.`,
    waitingLine,
    `PRDs: ${slugs.join(', ')}`,
  ];
  if (reportPaths.length) lines.push(`Reports: ${reportPaths.join(', ')}`);
  return lines.join('\n');
}

/**
 * holdMsFromEnv(env) → milliseconds a needs_review park waits, with no
 * ladder resolution, before it gets a grouped notice on its own (case b in
 * selectDueReviewNotices). SM_REVIEW_NOTICE_HOLD_MINUTES must be a positive
 * number; anything else (unset, zero, negative, NaN) falls back to the
 * DEFAULT_HOLD_MINUTES default.
 */
function holdMsFromEnv(env = process.env) {
  const raw = Number(env.SM_REVIEW_NOTICE_HOLD_MINUTES);
  const minutes = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_HOLD_MINUTES;
  return minutes * 60000;
}

module.exports = {
  DEFAULT_HOLD_MINUTES,
  buildReviewNotice,
  selectDueReviewNotices,
  formatReviewNotice,
  holdMsFromEnv,
};

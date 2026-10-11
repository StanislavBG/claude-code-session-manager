/**
 * scheduler/reviewLadder.cjs — needs_review / auto-fix / auto-reset eligibility
 * predicates, selectors and their verdict sets + thresholds. Extracted verbatim
 * from scheduler.cjs; the queue-mutating ladder rungs stay there and call in.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const schedulerPaths = require('../lib/schedulerPaths.cjs');
const jobWorktree = require('../lib/jobWorktree.cjs');
const { classifyRunOutcome } = require('../lib/reaperHelpers.cjs');
const { COMPLETED_EQUIVALENT_VERDICTS } = require('../lib/terminalRunOutcome.cjs');
const { resolveIsFixPlan } = require('../lib/fixPlanSlug.cjs');
const { GATE_AUTHORITY_VERDICTS } = require('../lib/gateAuthority.cjs');
const { DEFAULT_PROJECT_CWD } = require('../lib/schedulerBatch.cjs');

/**
 * Resume-first recovery (PRD 1111). A job parked in needs_review with verdict
 * 'uncommitted_changes' has a live claude session (job.sessionId, minted by
 * spawnJob's `--session-id`) that already has full context of the work it
 * left uncommitted — resuming it via `claude -p --resume <sessionId>` lets it
 * finish its own finish-protocol COMMIT step, instead of spawnInvestigation
 * cold-reading the log to author a fix-plan PRD that a FRESH session then has
 * to re-derive that same context for. Pure/no I/O so the eligibility rule can
 * be unit-tested directly, matching classifyFailureOutcome/commitGuardVerdict.
 *
 * Bounded to exactly one attempt via job.resumeRecoveryAttempted, stamped
 * atomically with the 'running' transition inside spawnJob's own dispatch
 * mutate (see spawnJob) — never here — so a crash between this function
 * returning a target and the resume child actually spawning cannot leave the
 * job re-eligible.
 *
 * Kill-switch: SM_RESUME_RECOVERY_DISABLE=1 restores today's behaviour
 * exactly (always returns null), mirroring SM_RCA_DISABLE/SM_DOD_DISABLE.
 */
function selectResumeRecoveryTarget(job) {
  if (process.env.SM_RESUME_RECOVERY_DISABLE === '1') return null;
  if (!job || job.status !== 'needs_review') return null;
  if (job.verifierVerdict !== 'uncommitted_changes') return null;
  if (typeof job.sessionId !== 'string' || job.sessionId.length === 0) return null;
  if (job.resumeRecoveryAttempted === true) return null;
  const dirtyPaths = Array.isArray(job.uncommittedPaths)
    ? job.uncommittedPaths.filter((p) => typeof p === 'string' && p.length > 0)
    : [];
  if (!dirtyPaths.length) return null;
  return { slug: job.slug, sessionId: job.sessionId, dirtyPaths, salvagePatch: job.salvagePatch || null };
}

/**
 * Mechanical recovery (PRD 1130). isFixPlanBeyondDepthCap (below) is the
 * ONLY gate on re-investigating a fix-plan job at investigationDepth >= 2 —
 * correct for open-ended "author another plan" recursion, but it also
 * strands a depth-capped job whose failure was fully mechanical (no
 * judgement required) with no other ladder rung, since resume-first recovery
 * (selectResumeRecoveryTarget above) is hard-gated on verdict
 * 'uncommitted_changes'. This rung is evaluated INDEPENDENTLY of
 * isFixPlanBeyondDepthCap — depth never disqualifies it, because unlike
 * auto-fix it authors no plan and spawns no model; it is pure git.
 *
 * The closed set of mechanically-resolvable verdicts starts at exactly
 * 'worktree_integration_failed', which covers two subtypes (job.
 * integrationFailureKind): `blocking_paths` — PRD 1125 taught integrateBranch
 * to parse git's "would be overwritten by merge" stderr, verify the blocking
 * paths are byte-identical to the branch, discard the proven duplicates and
 * retry once, so a re-call can genuinely succeed once the dirty files are
 * gone — and `content_conflict`, which PRD 1125 explicitly does NOT handle
 * (parseBlockingMergePaths returns null for it). Only pure-addition text
 * conflicts are auto-resolved (mc-02, gitWorktree.cjs, kill switch
 * SM_PURE_ADDITION_MERGE_DISABLE=1) — and that already ran inside the
 * original failed integration. Re-calling integrateBranch for a content
 * conflict that survived it, against an unmoved base HEAD, fails
 * deterministically, so the selector skips it (WITHOUT spending the one
 * attempt) until HEAD moves — a sibling merge may make the retry succeed.
 * A job parked with this verdict has its `sm-job/<slug>` branch preserved
 * (cleanupJobWorktree's `keepBranch: !integration.ok`).
 *
 * Bounded to exactly one attempt via job.mechanicalRecoveryAttempted,
 * stamped in the SAME mutate as the outcome (performMechanicalRecovery,
 * below) — never here — so this selector alone can be unit-tested exactly
 * like selectResumeRecoveryTarget/selectLeftoverQuarantineTarget.
 *
 * Kill-switch: SM_MECHANICAL_RECOVERY_DISABLE=1 restores today's behaviour
 * exactly (always returns null), mirroring SM_RESUME_RECOVERY_DISABLE.
 */
const MECHANICALLY_RESOLVABLE_VERDICTS = new Set(['worktree_integration_failed']);

/**
 * True when a retry is provably futile: a content_conflict whose base HEAD is
 * the same as at failure time. Unknown state (no stamp, null current HEAD)
 * is NOT futile — falls back to attempting the retry.
 */
function isMechanicalRecoveryFutile(job, currentHeadSha) {
  return job.integrationFailureKind === 'content_conflict'
    && !!job.integrationBaseHeadSha
    && !!currentHeadSha
    && job.integrationBaseHeadSha === currentHeadSha;
}

function selectMechanicalRecoveryTarget(job, currentHeadSha = null) {
  if (process.env.SM_MECHANICAL_RECOVERY_DISABLE === '1') return null;
  if (!job || job.status !== 'needs_review') return null;
  if (!MECHANICALLY_RESOLVABLE_VERDICTS.has(job.verifierVerdict)) return null;
  if (job.mechanicalRecoveryAttempted === true) return null;
  if (isMechanicalRecoveryFutile(job, currentHeadSha)) return null;
  const cwd = job.cwd || DEFAULT_PROJECT_CWD;
  return {
    slug: job.slug,
    cwd,
    branch: jobWorktree.branchNameFor(job.slug),
    carriedPaths: job.carriedPaths || [],
    baseBranch: job.worktreeBaseBranch || null,
  };
}

/**
 * Pure predicate: a needs_review row parked as shared_tree_reverted that
 * carries a landedCommit — the only shape reverifyNeedsReview can re-check
 * against ground truth (landedCommitIsAncestorOfHead). Deliberately
 * independent of autoFixAttempted: 1229-fo-03 was parked with
 * autoFixAttempted:true and no autoFixOutcome (isStrandedAutoFixPark shape),
 * yet isStrandedAutoFixPark could not release it — that ladder only resolves
 * once job.looksDone is set, and reverifyNeedsReview computes looksDone only
 * for isRescanCandidate / isGuardParkedWithoutAutoFix rows, neither of which
 * a shared_tree_reverted + autoFixAttempted row is.
 */
function isStaleSharedTreeRevertedPark(job) {
  return !!job && job.status === 'needs_review'
    && job.verifierVerdict === 'shared_tree_reverted'
    && typeof job.landedCommit === 'string' && job.landedCommit.length > 0;
}

/**
 * The fix-plan slug spawnInvestigation authors for a given failed job —
 * shared by selectAutoFixTargets (queue-membership check) and
 * reverifyNeedsReview's autofix_plan_unqueued annotation (same check, run
 * one or more passes later) so both use one slug formula.
 */
function fixSlugFor(job) {
  return `${String(job.parallelGroup ?? 99).padStart(2, '0')}-fix-${job.slug.replace(/^\d+-/, '')}`;
}

// Transcript-scan verdicts that re-running verifyRun can re-evaluate. NOT
// 'uncommitted_changes' — that comes from the git commit-guard, which verifyRun
// does not inspect, so re-scanning it would always return 'clean' and wrongly
// heal a genuinely-unfinished job. 'no_verdict_sentinel' is included because
// its raising condition (sentinel === null && !committedDuringRun) depends on
// commit-detection, which committedInWindow() can fix retroactively (e.g. the
// git-log --all scan added for missed non-HEAD commits) — rescanning lets a
// job whose commit is now correctly detected clear on its own instead of
// staying stuck in needs_review forever. 'pass_no_commit' is included because
// verifyRun now exempts fix-plan jobs (slug ^\d+-fix-) from that check — a
// fix-plan job flagged before that exemption shipped gets a genuinely
// different verdict on rescan (2026-07-12: false-positive cascade where
// investigation jobs correctly found "nothing to fix" but were flagged
// anyway). For non-fix-plan jobs the exemption never applies, so rescanning
// their pass_no_commit verdict is a harmless no-op (same facts, same verdict).
const RESCANNABLE_VERDICTS = new Set(['transcript_errors', 'verify_unavailable', 'no_verdict_sentinel', 'abandoned_background_task', 'pass_no_commit', 'pass_no_commit_already_shipped']);
// RESCANNABLE_VERDICTS is a HINT, not a gate: it names the verdicts whose
// recovery rung is a transcript re-verification (verifyRun). Every other
// needs_review verdict is still a heal candidate (isRescanCandidate) — it just
// gets the evidence-only rung (computeLooksDone) instead of a transcript
// rescan, because verifyRun cannot see a commit-guard / shared-tree verdict and
// would return 'clean' and falsely heal it.

// The ONLY needs_review verdicts NOT eligible for the periodic heal ladder.
// An allow-list here was reopened three times (2026-09-12 x2, 2026-09-18
// shared_tree_reverted) because a new park reason was born invisible to
// self-healing. Add a verdict here only with a one-line proof that no
// re-verification or evidence scan can ever change it.
const RESCAN_EXCLUDED_VERDICTS = new Set([
  // Commit-guard verdict verifyRun never inspects: a rescan returns 'clean' and would heal genuinely unfinished work.
  'uncommitted_changes',
  // Its damage IS a commit stranded on an unmerged sm-job branch — a landedCommit restates it; selectMechanicalRecoveryTarget owns the real re-merge.
  'worktree_integration_failed',
  // The run overran its own time/cost estimate; no transcript or git evidence can un-overrun it (selectAutoFixTargets excludes it too).
  'budget_exceeded',
]);

// Per-pass / per-row bounds on the evidence-only rung (the widened candidate
// set). Each scan costs one computeLooksDone: a per-cwd-deduped `git fetch`
// (<=~20s) + a git log. Unbounded, a backlog of N parked rows would pay N of
// those every 10 minutes forever.
const REVERIFY_INTERVAL_MS = 10 * 60_000;
const EVIDENCE_SCAN_MAX_PER_PASS = 20;
const EVIDENCE_SCAN_MIN_INTERVAL_MS = 6 * REVERIFY_INTERVAL_MS;

// Bounds fix-plan recursion: cap N permits at most N+1 fix jobs per original
// slug (depth 1 = the original job, depth 2 = its `-fix`, depth 3+ is
// excluded). With N=1 that's `<slug>-fix` and `<slug>-fix-fix`, never a third
// `-fix-fix-fix`. Lowered from 2 to 1 on 2026-08-31 (starry-night-ships):
// three concurrent chains (115-fix-fix, 113-fix-fix, 111-fix-fix-fix) were
// riding the old cap, and 115-fix-fix's own root-cause section read "The
// code was already CORRECT. Only verification and commit failed." — a third
// auto-retry re-runs an entire PRD and test battery to redo a `git commit`,
// at near-zero marginal success probability. Shared by selectAutoFixTargets
// and spawnInvestigation so both call sites agree on one threshold.
const MAX_INVESTIGATION_DEPTH = 1;

/**
 * True when a fix-plan job's investigationDepth is at or past the recursion
 * cap and it must be excluded from auto-fix eligibility. A fix-plan job with
 * no recorded investigationDepth (a job already in the queue before this
 * depth tracking shipped) is treated as excluded too, preserving the
 * pre-existing blanket-exclusion behavior for legacy jobs — no retroactive
 * migration. Non-fix-plan jobs are never capped here.
 *
 * `isFixPlan` (PRD 1131) is the job's own persisted classification stamp
 * (see lib/fixPlanSlug.cjs's resolveIsFixPlan) — an explicit true/false wins
 * over the slug; only a row with the field entirely absent (persisted
 * before this change shipped) falls back to the legacy slug-only heuristic.
 * Exported for tests.
 */
function isFixPlanBeyondDepthCap(slug, investigationDepth, isFixPlan) {
  if (!resolveIsFixPlan(slug, isFixPlan)) return false;
  if (investigationDepth == null) return true;
  return investigationDepth >= MAX_INVESTIGATION_DEPTH + 1;
}

/**
 * Backfill a job's missing runId by scanning RUNS_DIR for a run directory
 * whose contents reference this job's slug (a '<slug>.log' file inside it).
 * A needs_review job can lose its runId (e.g. an old queue-schema gap) and
 * become invisible to every auto-resolution path that requires job.runId
 * truthy. O(number of run dirs) — a single readdir + per-dir existsSync
 * check, no nested loop over user-scaled data. Dir names are ISO timestamps,
 * so lexical-descending sort picks the newest match. Exported for tests.
 */
function resolveRunId(job, { runsDir = schedulerPaths.runsDir() } = {}) {
  if (!job || job.runId) return job?.runId || null;
  if (!job.slug) return null;
  let dirs;
  try {
    dirs = fs.readdirSync(runsDir);
  } catch {
    return null;
  }
  const matches = dirs.filter((d) => {
    try {
      return fs.existsSync(path.join(runsDir, d, `${job.slug}.log`));
    } catch {
      return false;
    }
  });
  if (!matches.length) return null;
  matches.sort().reverse();
  return matches[0];
}

/**
 * Pure predicate: a needs_review job with no runId and no backfillable run
 * directory can never self-heal or get an auto-fix investigation — it must
 * be surfaced for a human rather than silently dead-ended. Exported for
 * tests.
 */
function isUnresolvableNeedsReview(job, { hasRunDir }) {
  return !!job && job.status === 'needs_review' && !job.runId && !hasRunDir;
}

/**
 * Pure predicate: an auto-fix attempt whose one bounded retry is already
 * spent, and whose outcome was NOT 'plan' (a produced plan is judged by
 * isPlanUnqueued instead — a plan is never retried, only annotated if it
 * never reaches the queue). Covers all three exhaustible outcomes
 * ('no-plan', 'error', and unstamped/undefined) — mirrors the retry
 * eligibility rule in selectAutoFixTargets so a job can never be retry-
 * eligible there and simultaneously un-annotatable here.
 *
 * A parent stamped `autoFixReopened: true` (its dead fix-plan child earned
 * it exactly one further attempt — see isFixPlanDead) is a separate
 * exhaustion path: it is spent as soon as that second investigation
 * concludes with ANY outcome, including another 'plan' — a reopened parent
 * never gets a third attempt, so unlike the fresh case a 'plan' outcome does
 * not exempt it here.
 */
function isExhaustedAutoFix(job) {
  if (!job || job.status !== 'needs_review' || job.autoFixAttempted !== true) return false;
  if (job.autoFixReopened === true) return job.autoFixOutcome != null;
  return job.autoFixOutcome !== 'plan' && (job.autoFixRetries ?? 0) >= 1;
}

/**
 * Verdicts from the POST-RUN GUARDS (commit-guard / shared-tree guard) that a
 * later, independently-checkable commit/looksDone signal can meaningfully
 * confirm or refute. Auto-fix investigations only ever launch for FAILING
 * runs (see isExhaustedAutoFix above and selectAutoFixTargets) — a job parked
 * by one of these GUARD verdicts exits 0 and never has autoFixAttempted set,
 * so it is invisible to isExhaustedAutoFix and can sit in needs_review
 * forever with nothing to spend and nothing to exhaust (PRD 1181, 2026-09-12:
 * exit 0, commit aff5607 landed, parked on a shared-tree verdict, cleared
 * only by a human).
 *
 * 'worktree_integration_failed' is deliberately EXCLUDED — its damage IS a
 * commit: one stranded on an unmerged `sm-job/<slug>` branch. A `landedCommit`
 * existing is not evidence against that verdict, it is a restatement of it,
 * so admitting it here would auto-complete a row whose work never actually
 * reached the target branch. It already has its own dedicated, git-native
 * resolution path (selectMechanicalRecoveryTarget / performMechanicalRecovery
 * — a real re-attempted merge) and must never be pulled into this ladder.
 *
 * 'pidless_reap_with_landed_commit' (PRD 1173, resolvePidlessFailureOverride
 * in reaperHelpers.cjs) is included: it parks on the exact same shape (exit
 * never observed / no autoFixAttempted, real landedCommit evidence) as
 * 'silent_no_op' and 'shared_tree_reverted', and this ladder never trusts
 * landedCommit alone anyway — applyNeedsReviewAutoResolve only resolves once
 * job.looksDone independently reconfirms via a fresh commits-since-this-run
 * scan, which is exactly the "does the commit correspond to THIS dispatch"
 * re-verification resolvePidlessFailureOverride's own header says the
 * pidless-reap path itself cannot do. Omitting it here reproduces the same
 * "nothing to spend, nothing to exhaust" needs_review stall this PRD exists
 * to fix, just for a third verdict.
 */
const GUARD_VERDICT_EVIDENCE_ELIGIBLE = new Set(['silent_no_op', 'shared_tree_reverted', 'pidless_reap_with_landed_commit']);

/**
 * Pure predicate, no I/O: a needs_review row parked directly by one of the
 * GUARD_VERDICT_EVIDENCE_ELIGIBLE verdicts, that never went through an
 * auto-fix investigation at all (autoFixAttempted is not true) — the
 * structural gap this PRD closes, distinct from isExhaustedAutoFix's "went
 * through auto-fix and spent it" case. A job that DID get an auto-fix
 * investigation is left to isExhaustedAutoFix's own ladder rather than this
 * one, even if its verifierVerdict happens to also be in the eligible set.
 * Exported for tests.
 */
function isGuardParkedWithoutAutoFix(job) {
  if (!job || job.status !== 'needs_review') return false;
  if (job.autoFixAttempted === true) return false;
  return GUARD_VERDICT_EVIDENCE_ELIGIBLE.has(job.verifierVerdict);
}

/**
 * Pure predicate, no I/O: a needs_review row whose auto-fix investigation
 * genuinely ran (autoFixAttempted === true) but whose outcome was NEVER
 * durably stamped at all — and that has nothing left in flight to wait on:
 * no live/queued fix-plan row at fixSlugFor(job).
 *
 * Distinct from isExhaustedAutoFix, which requires autoFixRetries >= 1 to
 * have already accumulated. spawnInvestigation's onExit handler restores the
 * job's status from 'investigating' back to needs_review in ONE mutate()
 * call (scheduler.cjs's spawnInvestigation, source
 * 'spawnInvestigation:onExit') and stamps autoFixOutcome ('plan' / 'no-plan'
 * / 'error') in a SEPARATE, later mutate() call — an app restart or process
 * death between the two leaves autoFixOutcome permanently unset, with
 * autoFixRetries never incremented either, so isExhaustedAutoFix never fires
 * and the row falls through every existing resolving door forever, re-scanned
 * by the periodic reverify pass against the same frozen transcript with no
 * new outcome to observe.
 *
 * Job 1218-fo-01 (2026-09-13, findings filed at
 * session-manager-operations/reviews/2026-09-13-scheduler-stability-investigation.md,
 * "post-run adjudication" section) sat exactly in this state: needs_review,
 * verifierVerdict transcript_errors, autoFixAttempted: true, autoFixOutcome:
 * undefined, autoFixRetries: undefined, statusHistory ending in
 * "investigation probe exited — restoring prior status" — with a landed
 * commit no existing ladder rung would credit.
 *
 * Deliberately narrower than "unset, 'error', or 'no-plan'": a row that DID
 * get a durably-stamped 'error'/'no-plan' outcome with its one bounded retry
 * still unspent (autoFixRetries < 1) is exactly the row
 * selectAutoFixTargets's own retryEligible check still owns and will retry
 * on its own — pulling it into THIS ladder instead would race it away from
 * that retry (scheduler-needs-review-autoresolve.test.cjs's "a non-exhausted
 * needs_review row … is left alone" guards exactly this). Only the
 * outcome-truly-never-stamped case is structurally unrecoverable by any
 * OTHER existing door, because nothing ever wrote a value selectAutoFixTargets
 * or isExhaustedAutoFix could act on.
 * Exported for tests.
 */
function isStrandedAutoFixPark(job, jobsInProject) {
  if (!job || job.status !== 'needs_review') return false;
  if (job.autoFixAttempted !== true) return false;
  if (job.autoFixOutcome != null) return false;
  const fixSlug = fixSlugFor(job);
  const liveOrQueuedChild = (jobsInProject || []).some(
    (j) => j.slug === fixSlug && j.status !== 'completed' && !DEAD_FIX_CHILD_STATUSES.has(j.status),
  );
  return !liveOrQueuedChild;
}

/**
 * Pure predicate, no I/O: is this needs_review row eligible for the bounded
 * auto-resolve ladder at all — either because its auto-fix path is genuinely
 * spent (isExhaustedAutoFix), because it was parked by a GUARD verdict that
 * never entered auto-fix in the first place (isGuardParkedWithoutAutoFix),
 * or because its auto-fix investigation ran but was stranded before
 * recording any outcome (isStrandedAutoFixPark). All three classes share ONE
 * ladder (applyNeedsReviewAutoResolve) rather than a duplicated one — the
 * ladder itself doesn't care which door a row came through, only whether it
 * now carries completion evidence (job.looksDone). `jobsInProject` is only
 * consulted by isStrandedAutoFixPark (to check for a live/queued fix-plan
 * child) and defaults to empty so existing single-arg callers are unaffected.
 * Exported for tests.
 */
function isEligibleForNeedsReviewAutoResolve(job, jobsInProject = []) {
  return isExhaustedAutoFix(job) || isGuardParkedWithoutAutoFix(job) || isStrandedAutoFixPark(job, jobsInProject);
}

/**
 * Pure predicate: an investigation produced a fix plan (autoFixOutcome ===
 * 'plan') but its fix-plan slug is not present among `queuedSlugs` — the
 * plan file failed to become a queue row (write failure, or some other
 * reason reconcile() never ingested it). `queuedSlugs` is the caller's
 * current job-slug set, passed in rather than read here so this stays pure.
 */
function isPlanUnqueued(job, queuedSlugs) {
  if (!job || job.status !== 'needs_review') return false;
  if (job.autoFixOutcome !== 'plan') return false;
  return !queuedSlugs.has(fixSlugFor(job));
}

// Terminal-and-not-completed statuses a fix-plan child can die in — see
// isFixPlanDead.
const DEAD_FIX_CHILD_STATUSES = new Set(['needs_review', 'failed', 'quarantined', 'skipped']);

/**
 * Pure predicate: a parent stuck at outcome 'plan' whose own fix-plan child
 * (fixSlugFor(job)) has ITSELF died — reached a terminal non-completed
 * status — with nothing left in the ladder that will ever revisit either
 * row again (selectAutoFixTargets skips a 'plan' outcome outright, and
 * isPlanUnqueued only fires when the child never reached the queue at all,
 * which isn't true once a dead child row exists). `job.autoFixReopened`
 * gates this to exactly once per parent — once stamped, this always returns
 * false so the parent can never be reopened a second time. Exported for
 * tests.
 */
function isFixPlanDead(job, jobsInProject) {
  if (!job || job.status !== 'needs_review') return false;
  if (job.autoFixOutcome !== 'plan') return false;
  if (job.autoFixReopened === true) return false;
  const fixSlug = fixSlugFor(job);
  const child = (jobsInProject || []).find((j) => j.slug === fixSlug);
  if (!child) return false;
  return DEAD_FIX_CHILD_STATUSES.has(child.status);
}

/**
 * Pure predicate: is this job eligible for the boot re-verify self-heal? Only
 * needs_review jobs with a run log (own or backfilled via resolveRunId) AND a
 * transcript-scan verdict. Crucially EXCLUDES 'uncommitted_changes' (git
 * commit-guard) — verifyRun can't see git, so re-scanning it would falsely
 * heal an unfinished job. Exported for tests.
 */
/**
 * healRefusalReason(job, verdict, committedDuringRun) → string | null
 *
 * Guards reverifyNeedsReview's needs_review → completed self-heal. Returns a
 * refusal reason when the heal must NOT happen, or null to allow it.
 *
 * THE INCIDENT (PRD 983, 2026-08-03). Job 972 ran 34 s, edited zero files and
 * exited 0. verifyRun correctly raised `no_verdict_sentinel` (no commit AND no
 * SCHEDULER_VERDICT sentinel) with downgradeTo 'needs_review', and the job was
 * parked. One minute later this self-heal pass promoted it to `completed`, and
 * that false green shipped to the user.
 *
 * The mechanism is subtle and worth spelling out, because the individual parts
 * all look correct: `no_verdict_sentinel` is in RESCANNABLE_VERDICTS, so the
 * job was re-verified. The rescan recomputes `committedDuringRun` via
 * `committedInWindow`, which runs `git log --all --since=<startedAt>
 * --until=<finishedAt+60s>` with NO author, message, or slug filter — it
 * answers "did ANY commit land in this repo during that window", not "did THIS
 * job commit". With up to 3 concurrent scheduler jobs plus interactive
 * sessions sharing one repo, a sibling job's commit lands inside the window
 * routinely. `committedDuringRun` therefore flipped to true on the rescan,
 * runVerify's `if (sentinel === null && !committedDuringRun)` no longer fired,
 * `no_verdict_sentinel` was never re-raised, the issue list came back empty,
 * and the verdict concluded `clean` — a COMPLETED_EQUIVALENT verdict, so the
 * job healed. Another job's commit was silently credited to this one.
 *
 * The rule: a run that emitted no sentinel and landed no commit ATTRIBUTABLE
 * TO ITSELF has produced no evidence it did anything, and repo-wide
 * time-window evidence is not attribution. `landedCommit` is per-job and
 * survives a resetJob (resetJobFields), so it is the honest signal here.
 * Bias to needs_review: a false yellow costs a human glance, a false green
 * costs a silently-unfixed bug — which is exactly what happened.
 */
// abandoned_background_task shares no_verdict_sentinel's exact rescan path
// (same "sentinel === null && !commitEvidence" gate in runVerify, same
// committedDuringRun repo-wide-not-per-job attribution problem) — the PRD 983
// incident mechanism above applies identically, so it gets the same guard
// rather than a carve-out that would silently reopen the same false-heal hole.
const NO_ATTRIBUTABLE_COMMIT_VERDICTS = new Set(['no_verdict_sentinel', 'abandoned_background_task']);

function healRefusalReason(job, verdict, committedDuringRun) {
  if (!job || !verdict) return null;
  if (!COMPLETED_EQUIVALENT_VERDICTS.has(verdict.verdict)) return null;
  if (!NO_ATTRIBUTABLE_COMMIT_VERDICTS.has(job.verifierVerdict)) return null;
  // A commit this job actually recorded as its own is real evidence; the
  // repo-wide window scan is not.
  if (job.landedCommit) return null;
  return `${job.verifierVerdict} with no job-attributable commit — refusing to heal`
    + ` (committedInWindow=${committedDuringRun === true} is repo-wide, not proof this job delivered)`;
}

/**
 * True when a `failed` job's failure is unverified-shaped — no result event
 * was ever recorded for its run (classifyRunOutcome === 'no_result'), so no
 * SCHEDULER_VERDICT sentinel could have been parsed either, OR it already
 * carries a RESCANNABLE_VERDICTS verifierVerdict. A row that failed with a
 * real result event (classifyRunOutcome === 'failed', i.e. a genuine red
 * gate or a real non-zero-exit error) is excluded — that failure is
 * evidence, not silence, and must never become a heal candidate (PRD 1102).
 */
function isFailedUnverifiedShaped(job) {
  if (!job || job.status !== 'failed') return false;
  if (job.verifierVerdict && RESCANNABLE_VERDICTS.has(job.verifierVerdict)) return true;
  const runId = job.runId || resolveRunId(job);
  if (!runId) return false;
  const logPath = path.join(schedulerPaths.runsDir(), runId, `${job.slug}.log`);
  return classifyRunOutcome(logPath) === 'no_result';
}

function isRescanCandidate(job) {
  if (!job) return false;
  // Default-ELIGIBLE: every needs_review row is a heal candidate unless its
  // verdict is in RESCAN_EXCLUDED_VERDICTS. No runId requirement here — a row
  // without one still gets the evidence rung and the unresolvable annotation.
  if (job.status === 'needs_review') return !RESCAN_EXCLUDED_VERDICTS.has(job.verifierVerdict);
  if (!(job.runId || resolveRunId(job))) return false;
  if (job.status === 'failed') return isFailedUnverifiedShaped(job);
  return false;
}

/**
 * Which rung a needs_review candidate gets (RESCANNABLE_VERDICTS as a hint):
 * true = transcript re-verification (needs a run dir to read); false = the
 * evidence-only rung. I/O only when a rescannable-verdict row lacks a runId.
 */
function isTranscriptRescannable(job) {
  return !!job && RESCANNABLE_VERDICTS.has(job.verifierVerdict) && !!(job.runId || resolveRunId(job));
}

/**
 * Pure, no I/O: the bounded subset of evidence-only needs_review candidates
 * reverifyNeedsReview scans this pass. Skips rows already carrying looksDone,
 * rows scanned within EVIDENCE_SCAN_MIN_INTERVAL_MS (evidenceScannedAt), and —
 * PRD 1136 — rows with a live auto-fix history unless they are an
 * auto-resolve door (isEligibleForNeedsReviewAutoResolve, which is what
 * consumes looksDone). Never-scanned rows go first, then least-recently
 * scanned; capped at EVIDENCE_SCAN_MAX_PER_PASS. O(n log n) in needs_review rows.
 * Per-pass cost ceiling: EVIDENCE_SCAN_MAX_PER_PASS computeLooksDone calls.
 */
function selectEvidenceScanTargets(jobs, now = Date.now()) {
  const due = [];
  for (const j of jobs ?? []) {
    if (j.status !== 'needs_review' || !isRescanCandidate(j)) continue;
    if (isTranscriptRescannable(j)) continue;
    if (j.looksDone) continue;
    if (j.autoFixAttempted === true && !isEligibleForNeedsReviewAutoResolve(j, jobs)) continue;
    const last = Date.parse(j.evidenceScannedAt ?? '');
    if (!Number.isNaN(last) && now - last < EVIDENCE_SCAN_MIN_INTERVAL_MS) continue;
    due.push({ j, last: Number.isNaN(last) ? 0 : last });
  }
  due.sort((a, b) => a.last - b.last);
  return due.slice(0, EVIDENCE_SCAN_MAX_PER_PASS).map((d) => d.j);
}

/**
 * Cheap-guard for the 10-minute periodic reverify tick. MUST be expressed in
 * terms of isRescanCandidate — not a hand-written status test — because the
 * two drifted once already: the guard only looked for a `needs_review` row
 * while isRescanCandidate had grown a `failed`/isFailedUnverifiedShaped arm,
 * so reverifyNeedsReview's failed → needs_review looksDone branch was
 * unreachable from the periodic path on any queue holding zero needs_review
 * rows. A `failed` row with no run log sat wedged for five days with the
 * self-heal that exists to inspect it never firing (only an app restart, via
 * the unguarded boot call, could reach it). Reported 2026-09-10 from
 * social-signals-trader.
 *
 * Reopened through a different door 2026-09-12 (starry-night-ships
 * 231-saturn-record-and-docs / 243-neptune-kurama-mode): the guard above only
 * covered isRescanCandidate (re-verification), but reverifyNeedsReview's auto-
 * fix loop ALSO lives behind this same guard, and a `needs_review` row whose
 * mechanical recovery already ran and failed (mechanicalRecoveryAttempted:
 * true, verdict still 'worktree_integration_failed', not itself a
 * RESCANNABLE_VERDICTS member) is invisible to isRescanCandidate — so the
 * next rung (a fix-plan investigation via selectAutoFixTargets) never got a
 * chance to fire either. Widened to OR in every live target of the recovery
 * ladder the periodic pass actually drives (selectMechanicalRecoveryTarget /
 * selectResumeRecoveryTarget / selectAutoFixTargets) so the guard can never
 * again be narrower than the work reverifyNeedsReview performs.
 *
 * Widened again (this PRD): a `needs_review` row parked directly by a GUARD
 * verdict with no auto-fix history (isGuardParkedWithoutAutoFix) is not an
 * isRescanCandidate either — RESCANNABLE_VERDICTS covers transcript-verifier
 * verdicts, not commit-guard/shared-tree-guard verdicts — but
 * reverifyNeedsReview's looksDone-annotation pass now runs for it too (see
 * that function). Same rule as always: never let this guard be narrower than
 * the work reverifyNeedsReview actually performs.
 *
 * Reopened a THIRD time 2026-09-18 (shared_tree_reverted parked 1229-fo-03
 * falsely, 19 of 20 pending rows held): the fix was not another OR-clause but
 * inverting the default — isRescanCandidate is now default-ELIGIBLE for every
 * needs_review row (RESCAN_EXCLUDED_VERDICTS names the few exceptions), so a
 * new park reason can never again be born unhealable. The OR-clauses below
 * are now redundant for needs_review rows and kept only for their
 * non-needs_review inputs.
 *
 * Cost: selectMechanicalRecoveryTarget/selectResumeRecoveryTarget and
 * isGuardParkedWithoutAutoFix are pure (no I/O). selectAutoFixTargets is
 * called with an injected fixSlugExists that always returns false — cheap
 * and deliberately over-inclusive (a false positive here just means one
 * extra periodic pass, never a missed one) so this guard never pays
 * selectAutoFixTargets's production fs.existsSync scan per tick.
 * resolveRunId's IO only fires for rows missing job.runId, same as
 * isRescanCandidate already incurs above.
 */
function shouldRunPeriodicReverify(jobs) {
  if (!Array.isArray(jobs)) return false;
  if (jobs.some((j) => isRescanCandidate(j) || isGuardParkedWithoutAutoFix(j) || isStaleSharedTreeRevertedPark(j))) return true;
  if (jobs.some((j) => selectMechanicalRecoveryTarget(j) || selectResumeRecoveryTarget(j))) return true;
  return selectAutoFixTargets(jobs, { fixSlugExists: () => false }).length > 0;
}

// Default 24h, overridable via SM_STUCK_FAILED_ESCALATE_HOURS — same
// env-override shape as QUARANTINE_ESCALATE_MS above.
const STUCK_FAILED_ESCALATE_MS = process.env.SM_STUCK_FAILED_ESCALATE_HOURS
  ? Number(process.env.SM_STUCK_FAILED_ESCALATE_HOURS) * 60 * 60_000
  : 24 * 60 * 60_000;

/**
 * Kill-switch gate for the stuck-failed escalation below
 * (SM_STUCK_FAILED_ESCALATE_DISABLE=1), mirroring the
 * SM_REVERIFY_PERIODIC_DISABLE / SM_RCA_DISABLE convention. A tiny wrapper
 * so the disable path is unit-testable without invoking the 10-minute
 * setInterval body directly.
 */
function stuckFailedEscalationDisabled() {
  return process.env.SM_STUCK_FAILED_ESCALATE_DISABLE === '1';
}

// Bounded automatic failed -> pending recovery (PRD 1151): a failed row gets
// up to FAILED_AUTORESET_CAP auto-reset attempts, each gated on having sat
// `failed` for FAILED_AUTORESET_MS, before the stuck-failed escalation below
// is allowed to page a human. Same env-override shape as
// STUCK_FAILED_ESCALATE_MS/QUARANTINE_ESCALATE_MS above.
const FAILED_AUTORESET_CAP = 3;
const FAILED_AUTORESET_MS = process.env.SM_FAILED_AUTORESET_MINUTES
  ? Number(process.env.SM_FAILED_AUTORESET_MINUTES) * 60_000
  : 10 * 60_000;

/**
 * Kill-switch gate for the failed-autoreset pass below
 * (SM_FAILED_AUTORESET_DISABLE=1), same shape as stuckFailedEscalationDisabled
 * above.
 */
function failedAutoResetDisabled() {
  return process.env.SM_FAILED_AUTORESET_DISABLE === '1';
}

/**
 * selectFailedAutoResetTargets(jobs, now, thresholdMs) →
 *   [{ slug, cwd, ageMs, attempts }]
 *
 * Pure selector — no IO, no `require` inside the function. Selects `failed`
 * rows whose newest statusHistory entry with `to === 'failed'` is older than
 * `thresholdMs` and whose failedAutoResetAttempts counter hasn't yet spent
 * FAILED_AUTORESET_CAP attempts. "Newest" (not first) matters because a row
 * can have failed more than once across its lifetime (an earlier auto-reset
 * attempt that itself failed again) — only the most recent failed-since
 * timestamp should gate the next attempt.
 *
 * Excludes a row whose newest failed-entry came from spawnJob:fail-dirty —
 * that source means a transient failure left genuinely uncommitted work in
 * the job's worktree and the system already decided once, deliberately, not
 * to auto-requeue it (see that call site's own comment: "could discard
 * uncommitted work left by the failed run"). This bounded auto-reset is a
 * different, slower mechanism and must not quietly override that decision
 * 10 minutes later — a human should look at a dirty worktree before it gets
 * re-driven.
 */
function selectFailedAutoResetTargets(jobs, now, thresholdMs) {
  const targets = [];
  for (const j of jobs ?? []) {
    if (j.status !== 'failed') continue;
    const attempts = j.failedAutoResetAttempts ?? 0;
    if (attempts >= FAILED_AUTORESET_CAP) continue;
    const history = j.statusHistory || [];
    let entry = null;
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i].to === 'failed') { entry = history[i]; break; }
    }
    if (!entry) continue;
    if (entry.source === 'spawnJob:fail-dirty') continue;
    const since = Date.parse(entry.at);
    if (Number.isNaN(since)) continue;
    const ageMs = now - since;
    if (ageMs < thresholdMs) continue;
    targets.push({ slug: j.slug, cwd: j.cwd ?? null, ageMs, attempts });
  }
  return targets;
}

/**
 * findStuckFailedJobs(jobs, now, thresholdMs) → [{ slug, cwd, ageMs }]
 *
 * Pure predicate (isRescanCandidate's own resolveRunId/classifyRunOutcome log
 * read is the only IO, gated per-job exactly like shouldRunPeriodicReverify
 * above). `failed` used to be a fully terminal state for every automated
 * recovery path — selectResumeRecoveryTarget/selectAutoFixTargets both
 * require needs_review, reapDeadRunningJobs only ever writes running →
 * failed, and reconcile-repair's to-pending is for structurally invalid rows.
 * That is no longer true: selectFailedAutoResetTargets above now drives a
 * bounded failed → pending auto-reset (LEGAL_TRANSITIONS already allowed the
 * edge). This escalation now only fires once that auto-reset budget is
 * genuinely spent (see the interval body's filter on failedAutoResetAttempts)
 * — a rescan candidate (isRescanCandidate) that has sat failed longer than
 * `thresholdMs` AND exhausted its auto-reset attempts can therefore go
 * silently stuck forever — job 4056-outcome-stats sat `failed` for five days
 * with no operator signal (reported 2026-09-10, social-signals-trader) even
 * though the periodic reverify pass (once shouldRunPeriodicReverify's guard
 * was fixed) WAS firing on it — reverifyNeedsReview's failed branch can
 * annotate looksDone but can never resolve a failed row itself (see its own
 * header). This is the visibility half that guard fix was missing: escalate
 * once per exhausted row, never requeue from here.
 *
 * `stuckFailedNotified` gates this to exactly once per row — once the caller
 * stamps it, this always excludes that row so a human is never re-paged on
 * every 10-minute tick for the same stuck job. A row with no recoverable
 * 'failed' timestamp is skipped rather than guessed at (mirrors
 * findStaleQuarantinedJobs above).
 */
function findStuckFailedJobs(jobs, now, thresholdMs) {
  const stuck = [];
  for (const j of jobs ?? []) {
    if (j.status !== 'failed') continue;
    if (j.stuckFailedNotified === true) continue;
    if (!isRescanCandidate(j)) continue;
    // Newest (not first) to === 'failed' entry — same rationale as
    // selectFailedAutoResetTargets above: a row can have failed more than
    // once across its lifetime (an earlier auto-reset attempt that itself
    // failed again), and only the CURRENT failure episode's age should gate
    // escalation. Using the first/oldest entry would report a stale age
    // (and become instantly escalation-eligible) for a row that failed
    // months ago, recovered, and has only just failed again.
    const history = j.statusHistory || [];
    let entry = null;
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i].to === 'failed') { entry = history[i]; break; }
    }
    if (!entry) continue;
    const since = Date.parse(entry.at);
    if (Number.isNaN(since)) continue;
    const ageMs = now - since;
    if (ageMs >= thresholdMs) stuck.push({ slug: j.slug, cwd: j.cwd ?? null, ageMs });
  }
  return stuck;
}

// Bounded automatic terminal decision for an EXHAUSTED needs_review row
// (isExhaustedAutoFix === true — auto-fix attempted, no plan produced,
// retries spent): up to NEEDS_REVIEW_RESOLVE_CAP requeue attempts (a
// needs_review -> pending -> ... -> needs_review round trip counts as one
// spent attempt), each gated on having sat exhausted-needs_review for
// NEEDS_REVIEW_RESOLVE_MS, before the row is auto-skipped so a `dependsOn`
// chain behind it always drains without an operator. Same env-override
// shape as FAILED_AUTORESET_MS above.
const NEEDS_REVIEW_RESOLVE_CAP = 2;
const NEEDS_REVIEW_RESOLVE_MS = process.env.SM_NEEDS_REVIEW_RESOLVE_MINUTES
  ? Number(process.env.SM_NEEDS_REVIEW_RESOLVE_MINUTES) * 60_000
  : 30 * 60_000;

/**
 * Kill-switch gate for the needs_review auto-resolve pass below
 * (SM_NEEDS_REVIEW_AUTORESOLVE_DISABLE=1), same shape as
 * failedAutoResetDisabled/stuckFailedEscalationDisabled above.
 */
function needsReviewAutoResolveDisabled() {
  return process.env.SM_NEEDS_REVIEW_AUTORESOLVE_DISABLE === '1';
}

/**
 * selectExhaustedNeedsReviewTargets(jobs, now, thresholdMs) →
 *   [{ slug, cwd, ageMs, attempts }]
 *
 * Pure selector — no IO. Selects `needs_review` rows eligible for the
 * bounded auto-resolve ladder (isEligibleForNeedsReviewAutoResolve — auto-fix
 * genuinely spent, parked by a GUARD verdict that never entered auto-fix at
 * all, or a stranded auto-fix park with no outcome ever recorded), whose
 * newest statusHistory entry with `to === 'needs_review'` is older than
 * `thresholdMs`, and whose exhaustedResolveAttempts counter has not yet
 * spent its cap.
 *
 * The inclusion bound is inclusive of the cap itself (`<= CAP`, not `<
 * CAP`): NEEDS_REVIEW_RESOLVE_CAP counts REQUEUE attempts already spent, and
 * the pass that observes attempts === CAP is exactly the one that must fire
 * the terminal skip (see the interval body's branch below) — excluding that
 * row here would mean the cap-exhausted row is never selected again and the
 * dependsOn chain behind it never drains, defeating this PRD's own purpose.
 */
function selectExhaustedNeedsReviewTargets(jobs, now, thresholdMs) {
  const targets = [];
  for (const j of jobs ?? []) {
    if (j.status !== 'needs_review') continue;
    if (!isEligibleForNeedsReviewAutoResolve(j, jobs)) continue;
    if ((j.exhaustedResolveAttempts ?? 0) > NEEDS_REVIEW_RESOLVE_CAP) continue;
    const history = j.statusHistory || [];
    let entry = null;
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i].to === 'needs_review') { entry = history[i]; break; }
    }
    if (!entry) continue;
    const since = Date.parse(entry.at);
    if (Number.isNaN(since)) continue;
    const ageMs = now - since;
    if (ageMs < thresholdMs) continue;
    targets.push({ slug: j.slug, cwd: j.cwd ?? null, ageMs, attempts: j.exhaustedResolveAttempts ?? 0 });
  }
  return targets;
}

/**
 * Pure helper — no I/O by default (resolveJobRunId is injectable; production
 * caller passes resolveRunId, which does touch disk). Returns the subset of
 * jobs eligible for automatic fix-plan authoring after a reverify pass
 * leaves them still in needs_review.
 *
 * Exclusion rules (all must pass):
 *   - status === 'needs_review'
 *   - a runId, own or backfilled via resolveJobRunId (need a run log to investigate)
 *   - not itself a fix-plan slug (avoids infinite recursion)
 *   - autoFixAttempted cap: a job with no prior attempt is eligible; a job
 *     whose prior attempt outcome was 'no-plan', 'error', or UNSTAMPED
 *     (investigation exited without recording any outcome — unknown is not
 *     "succeeded") gets ONE bounded retry (autoFixRetries < 1); a job whose
 *     outcome was 'plan' (a fix plan was produced) is never retried here —
 *     it either lands as a queue row on its own or gets flagged
 *     autofix_plan_unqueued by reverifyNeedsReview's annotation pass; an
 *     exhausted retry is excluded
 *   - no fix sibling on disk (fixSlugExists) or already in the queue
 */

function selectAutoFixTargets(jobs, { fixSlugExists, resolveJobRunId = resolveRunId }) {
  const slugsInQueue = new Set(jobs.map((j) => j.slug));
  return jobs.filter((job) => {
    if (job.status !== 'needs_review') return false;
    // A job parked here because it was blocked by a sibling's foreign WIP
    // three times in a row (never its own regression) has nothing for a
    // fix-plan investigation to diagnose — there is no code defect to
    // author a PRD against, only another job's still-uncommitted tree.
    if (job.blockedByForeignWip === true) return false;
    // A budget-killed job parks for a human/ladder decision, never an
    // auto-fix investigation or auto-retry — the run didn't fail, it simply
    // overran its own estimate; there's no code defect to diagnose (Out of
    // scope: "retrying or auto-resuming a budget-killed job" for this PRD).
    if (job.verifierVerdict === 'budget_exceeded') return false;
    // A stale re-run whose work already shipped (rcaReport's 'already-shipped'
    // class) must never buy a fix-plan PRD — there is nothing to fix, and the
    // correct recovery (archiving the PRD) is a human/reconcile action, not
    // an investigation.
    if (job.rcaRecoveryAction === 'archive') return false;
    // Resume-first recovery (PRD 1111): a job still eligible for its one
    // bounded `--resume` attempt must never also become a fix-plan target
    // in the same pass — see spawnInvestigation's own identical guard.
    if (selectResumeRecoveryTarget(job)) return false;
    // Mechanical recovery (PRD 1130): a job eligible for a pure-git retry
    // must never also become a fix-plan target — it needs no plan and no
    // model. Defensive: today's single mechanically-resolvable verdict
    // (worktree_integration_failed) is already excluded below via the depth
    // cap, but this must hold even if that stops being true.
    if (selectMechanicalRecoveryTarget(job)) return false;
    const runId = job.runId || resolveJobRunId(job);
    if (!runId) return false;
    if (isFixPlanBeyondDepthCap(job.slug, job.investigationDepth, job.isFixPlan)) return false;
    // A dead fix-plan child (PRD 1129) earns its parent exactly one further
    // attempt, bypassing the normal 'plan' exclusion and the fix-slug/queue
    // membership checks below — those checks exist to stop a FRESH
    // investigation from clobbering a live sibling, but here the sibling is
    // dead and reusing its slug is the whole point of the reopen.
    const dead = isFixPlanDead(job, jobs);
    if (job.autoFixAttempted) {
      const retryEligible = dead
        || job.autoFixOutcome === 'no-plan'
        || job.autoFixOutcome === 'error'
        || job.autoFixOutcome == null;
      if (!retryEligible) return false;
      if (!dead && (job.autoFixRetries ?? 0) >= 1) return false;
    }
    if (dead) return true;
    const fixSlug = fixSlugFor(job);
    if (fixSlugExists(fixSlug)) return false;
    if (slugsInQueue.has(fixSlug)) return false;
    return true;
  });
}

/**
 * Pure helper — no I/O by default (fixSlugExists is injectable). Answers
 * "does this single needs_review job qualify for an auto-fix investigation
 * right now?" by delegating to selectAutoFixTargets's eligibility rules
 * (same-1-attempt cap, depth cap, no fix sibling) against the full job list,
 * then checking whether this job is among the returned targets. Shared by
 * spawnJob's immediate same-tick path and (indirectly, via
 * selectAutoFixTargets itself) reverifyNeedsReview's periodic path, so both
 * use one eligibility definition rather than two divergent copies.
 */
function isEligibleForImmediateAutoFix(job, allJobs, fixSlugExists) {
  const targets = selectAutoFixTargets(allJobs, {
    fixSlugExists,
    resolveJobRunId: () => job.runId,
  });
  return targets.some((t) => t.slug === job.slug);
}

/**
 * Pure: picks the one needs_review row reverifyNeedsReview's background
 * shadow gate should run this pass, or null when none qualifies. No I/O:
 * `headByCwd` is a Map of cwd -> HEAD sha (or null), pre-fetched by the
 * caller with `gitHead` (which never rejects, so building it needs no
 * try/catch — a cwd whose read failed just maps to null here).
 *
 * A row is never picked when its cwd's HEAD is unknown (null) — there is
 * nothing to compare a recorded gateShadow against.
 *
 * Tier 1, skipped when `authorityDisabled`: a stale, gate-authority-eligible
 * row — verdict in GATE_AUTHORITY_VERDICTS, a non-empty landedCommit, and
 * stale (no gateShadow, or one at a different HEAD, or one not marked
 * `definitive`). Ordered so a row that never got a shadow run goes first,
 * then the oldest `gateShadow.ranAt` (an unparseable or missing `ranAt`
 * sorts as oldest), then queue order. Rule first, why second: the old pick
 * took the first stale row in queue order with no rotation, so in a busy
 * plan one row whose gate stays red forever could crowd out every other
 * row's turn (review finding #8).
 *
 * Tier 2: the first needs_review row with no gateShadow at all, in queue
 * order — today's plain observe-only rule, unchanged.
 *
 * Returns the first tier-1 row, else the tier-2 row, else null.
 */
function selectGateShadowTarget(jobs, headByCwd, { authorityDisabled = false } = {}) {
  const eligible = jobs.filter((j) => {
    if (j.status !== 'needs_review') return false;
    const head = headByCwd.get(j.cwd);
    return typeof head === 'string' && head.length > 0;
  });

  const isStale = (j) => {
    const head = headByCwd.get(j.cwd);
    return !j.gateShadow || j.gateShadow.head !== head || j.gateShadow.definitive !== true;
  };

  if (!authorityDisabled) {
    const ranAtMs = (j) => {
      const t = j.gateShadow ? Date.parse(j.gateShadow.ranAt) : NaN;
      return Number.isFinite(t) ? t : -Infinity; // never-run or unparseable sorts oldest
    };
    const tier1 = eligible.filter((j) => isStale(j)
      && j.verifierVerdict
      && GATE_AUTHORITY_VERDICTS.includes(j.verifierVerdict)
      && typeof j.landedCommit === 'string'
      && j.landedCommit.length > 0);
    if (tier1.length) {
      const ranked = tier1
        .map((j, i) => ({ j, i, neverRun: !j.gateShadow, ranAt: ranAtMs(j) }))
        .sort((a, b) => {
          if (a.neverRun !== b.neverRun) return a.neverRun ? -1 : 1;
          if (a.ranAt !== b.ranAt) return a.ranAt - b.ranAt;
          return a.i - b.i; // tie: queue order
        });
      return ranked[0].j;
    }
  }

  return eligible.find((j) => !j.gateShadow) ?? null;
}

module.exports = {
  selectResumeRecoveryTarget,
  MECHANICALLY_RESOLVABLE_VERDICTS,
  isMechanicalRecoveryFutile,
  selectMechanicalRecoveryTarget,
  isStaleSharedTreeRevertedPark,
  fixSlugFor,
  RESCANNABLE_VERDICTS,
  RESCAN_EXCLUDED_VERDICTS,
  REVERIFY_INTERVAL_MS,
  EVIDENCE_SCAN_MAX_PER_PASS,
  EVIDENCE_SCAN_MIN_INTERVAL_MS,
  MAX_INVESTIGATION_DEPTH,
  isFixPlanBeyondDepthCap,
  resolveRunId,
  isUnresolvableNeedsReview,
  isExhaustedAutoFix,
  GUARD_VERDICT_EVIDENCE_ELIGIBLE,
  isGuardParkedWithoutAutoFix,
  isStrandedAutoFixPark,
  isEligibleForNeedsReviewAutoResolve,
  isPlanUnqueued,
  DEAD_FIX_CHILD_STATUSES,
  isFixPlanDead,
  NO_ATTRIBUTABLE_COMMIT_VERDICTS,
  healRefusalReason,
  isFailedUnverifiedShaped,
  isRescanCandidate,
  isTranscriptRescannable,
  selectEvidenceScanTargets,
  shouldRunPeriodicReverify,
  STUCK_FAILED_ESCALATE_MS,
  stuckFailedEscalationDisabled,
  FAILED_AUTORESET_CAP,
  FAILED_AUTORESET_MS,
  failedAutoResetDisabled,
  selectFailedAutoResetTargets,
  findStuckFailedJobs,
  NEEDS_REVIEW_RESOLVE_CAP,
  NEEDS_REVIEW_RESOLVE_MS,
  needsReviewAutoResolveDisabled,
  selectExhaustedNeedsReviewTargets,
  selectAutoFixTargets,
  isEligibleForImmediateAutoFix,
  selectGateShadowTarget,
};

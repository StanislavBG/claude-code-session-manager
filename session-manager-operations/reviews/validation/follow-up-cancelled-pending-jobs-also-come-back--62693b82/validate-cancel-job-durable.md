# Validation: cancel-job-durable plan (2057, 2058, 2059)

Base: 023e442c (given). Commits in range: 14320b29 (2057), 3b7e4204 (2058), 9cb664ee (2059), merge 5b552d95.
Method: read the diff, re-ran every PRD gate in the foreground, ran an absence/grep check on `resetJobFields(` callers. Built-in /code-review and /security-review were not run; the combined diff was self-reviewed instead.

## 2057-ladder-skip-cancelled-jobs — VERIFIED
- `isCancelledJob` exported: reviewLadder.cjs (~L516, export in module.exports). It is true for a non-empty string `cancelledAt` or a newest `to===status` history entry with source `remote:cancelJob`; false for null or ordinary rows.
- The early skip is present in all six selectors: isRescanCandidate, selectEvidenceScanTargets, selectFailedAutoResetTargets, findStuckFailedJobs, selectExhaustedNeedsReviewTargets, selectAutoFixTargets (diff hunks).
- New test scheduler-ladder-cancelled.test.cjs exists.
- Gate: `vitest run scheduler-ladder-cancelled + scheduler-failed-autoreset` → 2 files, 14 tests passed. The autoreset test file is unchanged by the diff.

## 2058-cancel-job-durable-marker — VERIFIED
- scheduler.cjs `remote.cancelJob` stamps `j.cancelledAt` inside the mutate, which covers both the failed and needs_review outcomes because targetStatus is shared. It returns `cancelledAt`.
- `resetJobFields` (L2678) returns false for a cancelled job unless source is `remote:resetJob` or `ipc:schedule:reset-job`. It runs `delete job.cancelledAt` after a successful transition.
- Skips added at autoResetFailed loop (~L9978), `healTargetForFix` (~L4853), spawnInvestigation statusEligible (~L5196, transition short-circuited), and applyNeedsReviewAutoResolve (~L8528).
- Caller grep (`resetJobFields(`): the callers are applyOrphanOutcome, foreign-WIP requeue, dead-fix-plan reopen, launch-failure, halt-reset, verify-downgrade, transient-retry, rate-limit reap and autoResetFailed. All pass automated sources, so the guard refuses a cancelledAt row. Only L9593 (`ipc:schedule:reset-job`) and L10597 (`remote:resetJob`) are admin sources. No other caller can revive a cancelled row.
- Tests: scheduler-cancel-durable.test.cjs cancels through remote.cancelJob. It then drives autoResetFailed, transient-retry and applyOrphanOutcome (all refused), checks healTargetForFix returns null, and checks that `remote:resetJob` succeeds, clears the marker and leaves the row pending.
- Gate: 5 test files, 39 tests passed. `npm run typecheck` exit 0.

## 2059-settle-digest-cancelled-section — VERIFIED
- epicSettle.cjs local `isCancelledRow` (failed or needs_review with `cancelledAt`, or the history fallback). It builds a sorted `cancelled` list and filters it out of `parked` and `failed`. `cancelled` is in the digestKey hash and in hasContent.
- epicValidationHook.cjs prints `Cancelled (N) — stopped by scheduler_cancel_job; only scheduler_reset_job revives them:` plus `- <slug>` lines, omitted when empty.
- Tests added to epicSettle.test.cjs cover cancelled vs ordinary failed, the needs_review history fallback, hasContent/digestKey, and the digest section with and without cancelled rows.
- Gate: epicSettle + epicSweepValidator → 2 files, 19 tests passed.

## Findings
### Critical
- none
### Important
- none
### Minor
- reviewLadder.cjs ~L510–526: the new `isCancelledJob` and its comment were inserted between the pre-existing docblock ("excluded — that failure is evidence...") and `isFailedUnverifiedShaped`. That detaches the docblock from its function. Cosmetic only.
- The `isCancelledJob` rule is duplicated by design as `isCancelledRow` in epicSettle.cjs. The PRD required this, and the two rules differ slightly (the settle copy also checks status). They could drift.
- The statusHistory fallback means legacy rows cancelled before the marker existed stay protected, but only while the cancel entry is still the newest `to===status` entry.

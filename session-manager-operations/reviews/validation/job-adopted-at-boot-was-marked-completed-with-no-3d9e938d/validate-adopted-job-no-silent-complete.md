# Validation: adopted job no silent complete

Base: f0907f03 (HEAD e946b0a2). PRD files found in prds-archived/. Commits per PRD: e774dd5d (2891), c1287bcb (2892), 24136109 (2893), 1cee1fc4 (2894), e946b0a2 (2895).
Gates re-run (SM_* env unset): one vitest run over all 11 gate spec files -> 11 files / 351 tests passed; `npm run typecheck` exit 0.

## worktree-removal-snapshots-uncommitted-work — VERIFIED
- UNCOMMITTED_REF_PREFIX in gitExec.cjs (diff +9/-1), used at gitWorktree.cjs snapshotUncommittedWork (`sharedGitExec.UNCOMMITTED_REF_PREFIX`).
- snapshotUncommittedWork: null when clean/identical-to-main; temp GIT_INDEX_FILE, commit-tree parent HEAD, update-ref in main tree; `{error,paths}` on failure; no stash used.
- removeWorktreeDir returns {removed,snapshot}, keeps dir on error; teardownOrphanedCheckout keeps dir on snapshot error or unresolved main tree + dirty; cleanupWorktree returns {snapshot,removed}.
- reconcileWorktreesOnBoot returns snapshots/kept, skips branch delete on kept; reclaimTerminalJobOrphans/sweepStale count only removed.
- worktreeRunCommitCount via reflog regex, -1 on failure; jobWorktree.cjs exports both (+2 lines). Test file gitWorktreeUncommittedSnapshot.test.cjs (199 lines) passes.

## reaper-commit-guard-for-worktree-runs — VERIFIED
- scheduler.cjs reapDeadRunningJobs pre-mutate block: dirt, salvage patch, snapshot, runMadeCommit; commitGuardVerdict with ranInWorktree:true, silent_no_op via resolveCommitGuardOutcome(findSatisfyingCommitOnMain); non-already_satisfied verdict sets effectiveSuccess=false + notLandedInfo.
- Mutate stamps salvagePatch/uncommittedSnapshot/applyLeftoverFields; schema (scheduleJobSchema.cjs) and api.d.ts have uncommittedSnapshot.
- scheduler-reap-worktree-commit-guard.test.cjs (145 lines) exists, includes adoptedAtBoot dead-pid success zero-commit cases asserting needs_review / uncommitted_changes / silent_no_op, plus completed cases (own commit merged, artifact-only, fix-plan); passes.
- All git work happens in the pre-mutate integrationResults loop; mutate only reads the map.

## boot-orphan-uncommitted-snapshot-parks — VERIFIED
- Boot block keeps sweep.snapshots in a Map, looked up by cwd+slug (slug fallback), passed as 5th arg to applyOrphanOutcome.
- applyOrphanOutcome: success + snap, no landed commit -> needs_review/uncommitted_changes, error/finishedAt set, runtime deleted; snapshot stamped after the branch so reset can't drop it.
- finalizeJobWorktree wraps cleanupJobWorktree and returns uncommittedSnapshot; spawnJob stamps it.
- Tests in scheduler-boot-orphans.test.cjs (+34) and scheduler-finalize-worktree-snapshot.test.cjs (83) pass.

## finish-protocol-review-report-is-not-final-reply — VERIFIED
- FINISH_REVIEW_STEPS_IN_RUN gains "A review command may tell you its report must be your final reply. In this run it is not..." under step 2, before VERIFY; deferred variant unchanged. New test scheduler-finish-protocol-review-reply.test.cjs passes; tests/unit/schedulerFinish.spec.ts also touched.

## reaper-gate-outcome-from-verdict-line — VERIFIED
- reaperHelpers.cjs resolveReapGateOutcome reuses runVerify.cjs scanSentinel (no second parser), last verdict line wins; success without verdict -> 'unknown'. Reaper call site swapped for non-pidless rows; pidless keeps resolvePidlessGateOutcome. api.d.ts comment updated. Tests in reaperHelpers.test.cjs pass.

## Plan-diff review (requested extras)
- Dispatch-cap leak: cleanupWorktree decrements activeWorktreeCount unconditionally (gitWorktree.cjs ~1926) even when dir kept. No leak.
- Git work inside mutate(): none; applyOrphanOutcome is pure, reaper git work is pre-mutate, boot sweep runs before the boot mutate.
- Removal without snapshot: all `worktree remove`/`rm` of checkouts in gitWorktree.cjs go through removeWorktreeDir/teardownOrphanedCheckout (snapshot first). Remaining removals are scratch gate-shadow worktrees (scheduler.cjs ~9901/10044), not job checkouts.
- Security: temp index path uses crypto random under os.tmpdir; ref key passes safePinKey; no shell. No issues. (/code-review, /security-review not run separately; self-reviewed.)

## Findings
Critical: none.
Important: none.
Minor:
1. gitWorktree.cjs:~953 and ~968 ignore removeWorktreeDir's `{removed}`; when a snapshot fails the subsequent `worktree add`/branch -D fails and surfaces as a create error — acceptable but not explicit.
2. scheduler.cjs reaper: when `uncommittedChanges(wtDir)` is unreadable (dirt null) the guard is skipped and prior behaviour (completed) applies — a rare fail-open.
3. Diff range also contains unrelated finish-review plan commits (budget.cjs, reviewLadder.cjs, validator seed); not part of this plan, not reviewed.

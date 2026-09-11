---
title: A failed job with no post-window evidence has no automated path out — surface it, and stop stamping a never-spawned row with a runId it never used
cwd: /home/bilko/Projects/session-manager
estimateMinutes: 75
createdVia: scheduler-api
issuedAt: 2026-09-11T00:59:04.433Z
sourcePromptId: periodic-self-heal-is-gated-on-a-needs-review-ro-7c800415
tag: bug
agentType: dev-lead
---
# Goal

Inbound feedback from social-signals-trader (2026-09-10): job 4056-outcome-stats sat `failed` for five days with no automated recovery and no operator signal. The periodic-reverify guard drift it reported is already fixed (commit f4125f8, shouldRunPeriodicReverify), but that was NOT the operative cause — the machine-wide merged queue did hold needs_review rows, so the pass was firing and 4056 was in the candidate set. It got no looksDone annotation because computeLooksDone found no post-window commits touching its declared paths, and reverifyNeedsReview's failed branch can do nothing else. `failed` is therefore a fully terminal state for automated recovery: selectResumeRecoveryTarget and selectAutoFixTargets both require needs_review, reapDeadRunningJobs only writes running to failed, and reconcile-repair's to-pending is for structurally invalid rows. Only remote:resetJob (a human) ever takes the failed-to-pending edge LEGAL_TRANSITIONS permits. Make a silently-stuck failed row VISIBLE to the operator instead of silent, and stop a never-spawned row from inheriting a runId for a run that wrote none of its artifacts.

# Acceptance criteria

- [ ] A `failed` job that is a rescan candidate (isRescanCandidate true) and has been failed longer than a threshold (default 24h, env-overridable) is surfaced to the operator exactly once, via the same channel scheduler.cjs already uses in its age-based escalation interval block, naming the slug, its cwd, how long it has been failed, and that it needs a human Reset.
- [ ] Surfacing is idempotent: a flag stamped on the row prevents re-notifying on every 10-minute tick. A unit test asserts a second pass over the same row produces no second notification.
- [ ] Surfacing is behind a kill-switch env var matching the SM_REVERIFY_PERIODIC_DISABLE / SM_RCA_DISABLE convention already in scheduler.cjs; with the switch set, behaviour is byte-identical to today.
- [ ] A job reaped with 'no runtime.pid recorded' (spawn never completed) no longer keeps a runId whose run directory contains no artifacts for that slug: either the runId is cleared on that reap path, or reapDeadRunningJobs stamps a distinguishing field the row can be recognised by. A unit test covers a reaped row whose run dir holds only a sibling slug's files.
- [ ] No automatic failed-to-pending transition is added. Auto-requeueing a failure that may have left uncommitted work is explicitly out of scope (see spawnJob:fail-dirty) — this PRD only makes the stuck row visible.
- [ ] npm run typecheck, npm run lint and the scheduler unit suite are green. New tests are registered in vitest.config.ts's explicit include list (it is an allowlist — an unregistered file silently never runs).

# Implementation notes

All in src/main/scheduler.cjs unless noted.
- Guard fix for the reported Finding 1 already landed as commit f4125f8: shouldRunPeriodicReverify (near isRescanCandidate, ~line 7412) now reuses isRescanCandidate; test at src/main/__tests__/scheduler-periodic-reverify-guard.test.cjs. Do not redo it.
- Age-based escalation lives in the 10-minute rescheduleInterval block (~line 8360-8400) — put the stuck-failed sweep alongside it, and read the existing escalation's notification channel rather than inventing one.
- isRescanCandidate / isFailedUnverifiedShaped ~line 7396-7412; reverifyNeedsReview ~line 7551, its failed branch ~line 7558.
- reapDeadRunningJobs writes the 'no runtime.pid recorded after 10m' error — that is the reap path to stop stamping a phantom runId on. Note resolveRunId (~line 7238) backfills a missing runId by scanning RUNS_DIR, so clearing runId is not necessarily enough on its own; check what resolveRunId would then return for such a row and make the two agree.
- RUNS_DIR is ~/.claude/session-manager/scheduled-plans/runs; the merged queue is machine-wide (queueStore.readMergedSync unions every project's session-manager-operations/scheduler/state/queue.json plus scheduler-machine.json) — reason about candidate sets machine-wide, not per project.
- Test style: copy src/main/__tests__/scheduler-looks-done.test.cjs — it overrides process.env.HOME to a tmp dir BEFORE requiring scheduler.cjs, because every path is baked into a top-level const at require time.
- Do not run this project's own e2e suite as part of this job, and do not run the unit suite from inside a job worktree without a scratch TMPDIR.

# Out of scope

- Any automatic failed-to-pending requeue
- Changing reverifyNeedsReview's conservative never-auto-complete-a-failed-row rule
- Touching social-signals-trader's own repo

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).

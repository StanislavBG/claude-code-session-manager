# Scheduler operations — dispatch, recovery, diagnosis

`src/main/scheduler.cjs` is ~10,800 lines because it is not just a queue runner: it is a
multi-rung self-healing engine that has been rebuilt, incident by incident, to keep PRDs
flowing without a human watching it. This doc is the map of that machinery — what actually
drives a dispatch, what each recovery rung does and when, and a symptom → cause → remedy table
for "the scheduler looks stuck."

**Scope.** This doc does NOT restate: the PRD frontmatter/authoring contract (see
[`PRD_AUTHORING.md`](../../src/main/templates/PRD_AUTHORING.md)),
the on-disk storage layout (see [`scheduler/README.md`](../scheduler/README.md)), or the
completion-handler-desync runbook for a `queue.json` row stuck `"running"` after a clean exit
(see [`scheduler-ops-standards.md`](scheduler-ops-standards.md) — a different, narrower incident
than anything below). Every claim below is a live `file:line` reference, verified against the
working tree at the time this doc was written — `scheduler.cjs`/`gitWorktree.cjs` are large,
actively-edited files, so a line number here can drift; if a citation looks wrong, `grep` the
quoted function/constant name rather than trusting the number blindly.

## 1. The dispatch path — what actually drives `tickQueue`

`tickQueue()` (`src/main/scheduler.cjs:7139-7296`) is the single function that reads the queue,
runs every gate, and fires `spawnJob` for the next batch. It is a serialized promise tail
(`tickTail`, `:7134`) so concurrent callers never race the same pending rows. **There is no bare
timer that calls it directly on a fixed cadence** — every call is a reaction to one of:

- **A job finishing.** `spawnJob`'s own `finally` block calls `tickQueue()` on every exit path
  (success, failure, park) — the primary driver in a busy queue.
- **The billing poll loop.** `pollLoop()` re-arms itself via `setTimeout` and, on *every* branch
  (success, 429, auth failure, transient error) calls `maybeLaunchWhenAvailable(state)`
  (`:7350+`), which ticks when `firePolicy === 'when-available'` and utilization is under
  threshold. A poll does **not** need to succeed to trigger a tick.
- **The starvation watchdog**, forced from the 60s heartbeat timer, independent of the poll loop
  — see §3.
- **A human** — `runDueJobs()` (`:7330+`, Run now / resume-timer) is the only caller that can
  set `bypassLoadGate: true`.
- **A slot freeing up** — `sessionSlots.subscribe(() => tickQueue())` (registered in `init()`)
  fires on every `release()` and on `setCap()` raising the pool.
- **`reapDeadRunningJobs()` finishing its sweep** — ticks once more after finalizing dead rows.

### `lastRunAt` vs `lastDispatchAttemptAt`

Two different claims, both machine-wide fields on `scheduler-machine.json`
(`shapeMachine`, `src/main/lib/queueStore.cjs:223-240`):

| Field | Stamped | Proves |
| --- | --- | --- |
| `lastDispatchAttemptAt` | `scheduler.cjs:7160`, the FIRST thing inside `tickQueue` after the paused/unreadable/cancelled guards | The engine reached the picker this pass — regardless of whether anything launched |
| `lastRunAt` | `scheduler.cjs:7283`, only after slots/memory/load gates all passed and a batch is about to spawn | A batch actually launched |

The starvation watchdog (§3) deliberately keys off `lastDispatchAttemptAt`, not `lastRunAt`
(inside `runQueueStarvationWatchdog`, §3) — a poll that keeps "succeeding" while never reaching the picker would otherwise look
falsely fresh. **A stale `lastRunAt` with a fresh `lastDispatchAttemptAt` means the queue is
being evaluated and has nothing to fire (healthy-idle); a stale `lastDispatchAttemptAt` means
the ticking mechanism itself has stopped being invoked (the real stall).**

## 2. The slot pool — the one machine-wide concurrency cap

`src/main/lib/sessionSlots.cjs` is the ONLY concurrency limit the picker answers to
(`scheduler.cjs:7177-7181`, comment confirms a former private `concurrencyCap` of 3 was retired
in favor of this pool — see commit `4c8916d`).

- `MAX_SLOTS = 10` (`sessionSlots.cjs:32`) — hard ceiling.
- `DEFAULT_SLOTS = 5` (`:33`) — effective default, user-adjustable `[0, 10]` from the Home tab,
  persisted to `~/.claude/session-manager/session-slots-config.json` (`:35`, `setCap`/`readPersistedCap`
  `:41-66`); `SM_SESSION_SLOTS` env overrides everything (`:69-73`).
- `acquire(owner)`/`release(token)` (`:92-117`) are a token-paired map; a stuck holder is
  attributable via `snapshot()` (`:120-130`).
- **A `config.concurrencyCap: 4` (or `3`) field may still be sitting in a stale
  `scheduler-machine.json` on disk — it is vestigial.** `shapeMachine` doesn't strip unknown
  fields, but no dispatch code reads `config.concurrencyCap` after `4c8916d`. Don't diagnose a
  slot ceiling off that field; read `sessionSlots.snapshot()` (`scheduler_list_jobs` / `npm run
  health`) instead.
- A **separate, secondary** cap exists per job/Epic worktree (`src/main/lib/gitWorktree.cjs`,
  `getMaxConcurrentWorktrees` `:144-153`) — the job-kind default is floored at
  `sessionSlots.totalSlots()` so raising the slot pool can never silently strand jobs without
  worktree isolation. Its in-memory counter (`activeWorktreeCount`, `:184`) is **self-healing**:
  `reserveWorktreeSlot` (`:758-773`) re-verifies a would-be rejection against the real on-disk
  worktree count (`getObservedWorktreeCount`) before honoring it, correcting a leaked
  (never-decremented) counter down to reality rather than wedging the cap at a stale high-water
  mark for the rest of the process's life.

## 3. The starvation classifier — the last-resort safety net

`classifyQueueStarvation` (`scheduler.cjs:7398+`) answers one question: *there is pending
work — is anything actually going to run it?* It returns `null` (healthy) when paused, when
something is already running, when there's no pending work, or when idle time is under
`QUEUE_STARVATION_MS` (10 min, `:7369`). Otherwise it classifies:

- **`'starved'`** — at least one pending row is not behind a blocked `dependsOn` chain. A tick
  would help.
- **`'blocked'`** — every pending row is behind a terminal/parked dependency. Ticking cannot
  help; this needs a human or a heal pass.

`classifyQueueStarvationByProject` (`:7443+`) runs that check **per project cwd** rather
than machine-wide — a single long job in one project used to disarm the watchdog for every
other project (2026-09-12 incident, comment just above it).

`runQueueStarvationWatchdog` (`:7485-7545`), called every 60s from the heartbeat timer
independently of the billing poll loop, is the action half: it logs+audits one event per
starved/blocked project, and — if anything is `'starved'` — force-clears a stuck `cancelToken`
("the watchdog must be able to un-wedge this too") and forces exactly ONE machine-wide
`tickQueue({ bypassLoadGate: false })` near the end of the function, per pass.

## 4. The `needs_review` recovery ladder

Six named rungs, defined once as the closed set `LADDER_RUNGS`
(`src/main/lib/needsReviewLedger.cjs:34-41`) and classified from the `source` string every
`transitionJob` call carries (`classifyLadderRung`, `:54-71`). The gauntlet at
`scheduler.cjs:~6484-6950` tries rungs 1-3 same-tick, immediately on park; rung 4 fires same-tick
if 1-3 don't apply; rung 5 (`reverifyNeedsReview`) is the periodic catch-all for anything the
same-tick path missed (app restarted mid-episode, etc.) — it re-runs the SAME selectors, not a
different algorithm.

| # | Rung | Entry condition | Exit |
| --- | --- | --- | --- |
| 1 | **mechanical-recovery** | `selectMechanicalRecoveryTarget` (`:4111+`): `verifierVerdict === 'worktree_integration_failed'` (the one verdict PRD 1125 already taught `integrateBranch` to auto-resolve on retry) and not yet attempted. Kill switch `SM_MECHANICAL_RECOVERY_DISABLE=1`. | `performMechanicalRecovery` (`:4134+`) re-attempts `integrateJobBranch` — pure git, no model call. Success → `completed` (source `scheduler:mechanicalRecovery`). Failure → stays `needs_review`, `mechanicalRecoveryAttempted=true` stamped either way (one bounded attempt, falls through to the next rung). |
| 2 | **resume-recovery** | `selectResumeRecoveryTarget` (`:4037+`): `verifierVerdict === 'uncommitted_changes'`, a live `sessionId`, non-empty `uncommittedPaths`, not yet attempted. Kill switch `SM_RESUME_RECOVERY_DISABLE=1`. | One bounded `claude -p --resume <sessionId>` dispatch asking the SAME session to finish its own commit — falls through ordinary `spawnJob` finalize (park/fail/complete again). |
| 3 | **quarantine** | `selectLeftoverQuarantineTarget` (`:4186+`): resume recovery already spent AND the job parked `needs_review`/`uncommitted_changes` again, excluding any path already dirty pre-run (`preRunDirtyPaths`) — never touches foreign WIP. Kill switch `SM_LEFTOVER_QUARANTINE_DISABLE=1`. | `quarantineLeftovers`/`performLeftoverQuarantine` (`:4303+`, `:4404+`) commits the job's own leftovers onto a throwaway `sm-salvage/<slug>` ref (never `git stash`) and restores the shared tree to baseline. **The row itself stays `needs_review`** — no `transitionJob` call site resolves it directly; the tree being clean again is what lets a LATER worktree merge for this project succeed. |
| 4 | **auto-fix** | `isEligibleForImmediateAutoFix`/`selectAutoFixTargets` (`:8996+`, `:8932+`): not resume/mechanical-eligible, has a `runId`, under `isFixPlanBeyondDepthCap` (`:8315`), one bounded retry (only if the prior `autoFixOutcome` was `'no-plan'`/`'error'`/unset). Capped machine-wide by `MAX_CONCURRENT_INVESTIGATIONS=1`. | `spawnInvestigation` (`:5218+`) launches a **fresh-context** `claude -p` that authors a `fix-<slug>.md` PRD. Source `spawnInvestigation:start`; the fix-plan's own success promotes the original via `transitionJob(orig, 'completed', {source: 'spawnJob:auto-promote'})`. |
| 5 | **reverify** | `reverifyNeedsReview()` (`scheduler.cjs:9038+`), run once on boot and every 10 minutes (`shouldRunPeriodicReverify` gate) via `rescheduleInterval` (`:9895+`). Re-runs the verifier over stale `needs_review`/`failed` rows and computes a `looksDone` annotation (a later commit touching the PRD's declared paths). | Genuinely stale + still-passing verdict → `completed` (source `reverifyNeedsReview:heal`). A row with `looksDone` but no direct heal path is left for rung 6. |
| 6 | **bounded auto-resolve / manual-reset** | `applyNeedsReviewAutoResolve` (`:8840+`), gated by `selectExhaustedNeedsReviewTargets` (`:8792+`): an exhausted-auto-fix or guard-parked row that has sat `needs_review` for `NEEDS_REVIEW_RESOLVE_MS` (30 min, `:8761`). | `looksDone` → `completed`. Otherwise up to `NEEDS_REVIEW_RESOLVE_CAP=2` (`:8760`) requeues to `pending`; the cap-exhausted pass auto-`skip`s the row (`needsReviewAutoResolvedSkip`) so a `dependsOn` chain behind it still drains. Anything not matching one of the sources above (an explicit human `scheduler_reset_job`) buckets as `manual-reset` in the ledger. |

## 5. The reap/orphan path and its git-evidence gate

`reapDeadRunningJobs()` (`scheduler.cjs:7696+`) scans `queue.json` (never the in-memory
`runningSet` alone — a swallowed mutate error can desync the two) for `running` rows whose
`claude` process is provably dead, or whose spawn never recorded a `runtime.pid` at all
("pidless"). Before finalizing any such row to `'failed'`, it now consults
**`resolveLandedCommitEvidence(cwd, sha, sinceIso)`** (`:4264-4284`) — a bounded `git cat-file -e
<sha>^{commit}` plus a `git log -1 --format=%cI` timestamp check bounded to the row's own
`startedAt` (so a stale `landedCommit` surviving from an earlier dispatch of the same slug can
never falsely promote a LATER real failure). A row whose commit resolves gets promoted to
`completed` (source `reapDeadRunningJobs:landed`) instead of `failed`.

This gate was added in commit `44c3604` after job 1192 shipped a real, verifiable commit and
was still reaped `failed` because the reaper only ever judged spawn bookkeeping
(`runtime.pid`), never the `landedCommit` a row could already carry.

## 6. The launch circuit breaker

Full narrative + operator guidance already lives in
[`scheduler/README.md`](../scheduler/README.md#launch-circuit-breaker-non-runs-are-not-failures)
— read that first. The mechanics, in `src/main/lib/launchFailure.cjs`: a state machine keyed by
launch persona (`launchBlockKeyFor`, `:215-217`, keyed on `agentType`) — **closed → open/blocked
(exponential backoff, `armLaunchBlock` `:250-272`, capped at `BACKOFF_CAP_MS=1h` `:192`) →
half-open/probe (exactly one job through once backoff elapses, `evaluateLaunchGate` `:284-305`)
→ closed again on a real turn** (`resultShowsRealTurn`, `:172-175`). `LAUNCH_BLOCK_MAX_ATTEMPTS
= 8` (`:180`) after which the block stays open indefinitely until the CLI version changes or a
human clears it via Resume/Run now.

## 7. Diagnosis table

| Symptom | The ONE thing that distinguishes it | Expected remedy |
| --- | --- | --- |
| Pending rows, nothing running, queue looks frozen | `scheduler-machine.json`'s `lastDispatchAttemptAt` — fresh (< 10 min) means the engine is evaluating and has nothing to fire; stale means dispatch itself stopped being invoked | Fresh: wait, it's healthy-idle or gated (check `heldReason`/load gate). Stale: **automatic** — the 60s heartbeat's starvation watchdog (§3) force-ticks within 10 min; if it hasn't, `npm run health`'s `queue_dispatch`/`scheduler_queue` components are non-GREEN and name the cause |
| A `dependsOn` chain stalled behind one row | That row's `status` — if `needs_review`, check `job.exhaustedResolveAttempts` and how long it's dwelt (`statusHistory`'s last `to: 'needs_review'` entry) | If under 30 min: **automatic**, the ladder (§4) is still working through it. If exhausted (`exhaustedResolveAttempts` at cap): **automatic** — auto-skips within one more pass to unblock the chain. `blocked` (not `starved`) verdicts from §3 need a human |
| Slots saturated by an overrunning job | `sessionSlots.snapshot()` (via `scheduler_list_jobs` or `npm run health`) — `holders` names the owner; check the row's `budgetWarning` field (stamped at 75% of budget, `scheduler.cjs:~4858`) and `job.verifierVerdict === 'budget_exceeded'` | **Automatic, and tighter than the 4h deadman**: the wall-clock BUDGET watchdog (`computeJobBudgetMs`, `:1826-1833`) SIGTERMs a job once elapsed time passes `clamp(estimateMinutes × 3, 45min floor, 180min ceiling)` — calibrated against a p50=13m/p90=60m/max=240m run-duration profile — well before `MAX_JOB_DURATION_MS`'s 4h deadman would ever fire. A budget kill always parks `needs_review` with `verifierVerdict: 'budget_exceeded'` (`classifyBudgetKill`, `:1854-1861`; stamped near `:6570`) and is deliberately excluded from rungs 1-4 of the ladder (near `:6676`) — it only clears via rung 5/6 or a human |
| Torn `scheduler-machine.json` | `npm run health`'s `scheduler_queue.machineStateRecovered` field, or a `queueStore.recoverTornMachineState*` WARN/ERROR in logs | **Automatic** — `findLongestValidJsonPrefix` (`queueStore.cjs:261-286`) recovers the longest valid prefix and dispatch keeps running; health only goes non-GREEN as a loud "this happened" signal. A prefix mentioning `paused`/`resumeAt` in its discarded tail needs a human to verify pause status manually |
| Leaked worktree-cap counter (rows held `pending` with `heldReason: 'worktree cap reached...'` and 0 running) | `npm run health`'s `scheduler_queue.worktreeCapBlocked` (`health.cjs:171-188`, keys on `runningCount === 0` + the exact `heldReason` prefix) | **Automatic** — `reserveWorktreeSlot` (`gitWorktree.cjs:758-773`) re-verifies against the real on-disk worktree count before honoring a rejection, self-correcting a leaked in-memory counter without an app restart |
| A job's worktree was stranded (process died, checkout never cleaned up) | Directory age under the kind's worktree root vs `getStaleSweepAgeMs` (job: 24h, epic: 7d, `gitWorktree.cjs:94,103`) | **Automatic** — `sweepStaleWorktreeCheckouts` runs on boot (`reconcileWorktreesOnBoot`) and periodically, but only reaps past the age threshold AND only when no `/proc` process still holds the directory as its cwd (`hasLiveHolder`, `:700-713`) — a still-running job is never torn down early |

## 8. What recovers automatically vs what needs a human

**Automatic, no operator action required:** the starvation watchdog forcing a tick (§3); rungs
1, 2, 4, 5, and the bounded part of rung 6 of the needs_review ladder (§4); the reap/orphan
git-evidence gate promoting a wrongly-reaped row to `completed` (§5); the launch circuit breaker
re-probing on backoff and self-clearing on a CLI version change (§6); torn `scheduler-machine.json`
prefix recovery (§7); a leaked worktree-cap counter self-correcting against observed disk state
(§7); failed → pending auto-reset (up to 3 attempts over 10-minute windows); a stranded
`investigating` row being restored to its prior terminal status after 1 hour with no live probe.

**Genuinely requires a human (usually):** a `'blocked'` (not `'starved'`) verdict from §3 — every
pending row is behind a terminal/parked dependency and no automatic pass can resolve that; rung 3
(quarantine) never resolves a row by itself, only clears the shared tree so a later merge can
succeed — the row needs a real fix; a `verifierVerdict: 'budget_exceeded'` park (§7) — it is
excluded from ladder rungs 1-4 by design, so it sits until rung 5/6 finds `looksDone` evidence or
a human intervenes; a launch breaker that has exhausted
`LAUNCH_BLOCK_MAX_ATTEMPTS` (8) with no CLI version change; a `failed` row that has exhausted its
3 auto-reset attempts (`STUCK_FAILED_ESCALATE_MS`, 24h default, logs "reset it by hand via
scheduler_reset_job"); a quarantined row nobody has adopted past `QUARANTINE_ESCALATE_MS` (24h
default) — quarantine promotion out of `quarantined` only ever happens through the adopt path,
never a timer; a `worktree_integration_failed` verdict where the branch itself no longer exists
(mechanical recovery's one retry already failed).

## 9. Ops namespace

This file lives under `architecture/`, already a deliberately **NOT-owned**
`session-manager-operations/` namespace per CLAUDE.md (skill-authored docs, no concurrent-write
hazard) — no `opsOwnership.cjs`/`OWNERS` change is needed to add it.

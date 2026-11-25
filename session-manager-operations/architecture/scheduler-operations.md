# Scheduler operations — dispatch, recovery, diagnosis

`src/main/scheduler.cjs` is huge because it is not just a queue runner: it is a
multi-rung self-healing engine that has been rebuilt, incident by incident, to keep PRDs
flowing without a human watching it. This doc is the map of that machinery — what actually
drives a dispatch, what each recovery rung does and when, and a symptom → cause → remedy table
for "the scheduler looks stuck."

**Scope.** This doc does NOT restate: the PRD frontmatter/authoring contract (see
[`PRD_AUTHORING.md`](../../src/main/templates/PRD_AUTHORING.md)) or
the on-disk storage layout (see [`scheduler/README.md`](../scheduler/README.md)). The
completion-handler-desync runbook for a `queue.json` row stuck `"running"` after a clean exit is
[§9 below](#9-stuck-row-triage) — a different, narrower incident than anything above. Every claim below is a live `file:line` reference, verified against the
working tree at the time this doc was written — `scheduler.cjs`/`gitWorktree.cjs` are large,
actively-edited files, so a line number here can drift; if a citation looks wrong, `grep` the
quoted function/constant name rather than trusting the number blindly.

## Reliability target and feature freeze

About two thirds of the `bug` Epics the human files by hand (Sep 65%, Oct 70%, keyword-classified)
are about the scheduler/develop loop itself, and scheduler + prd + epic + git code is ~29k lines
(~42% of main-process code). The loop's own bugs dominate, so new mechanisms are frozen until it
is measurably reliable.

**Target — checked weekly, all four must hold:**

| Measure | Threshold | Source |
| --- | --- | --- |
| `refire_capped` parks | 0 | needs_review ledger |
| Human-filed `bug` Epics about the scheduler/develop loop | 0 | Epic tags (`bug` tag, human-created, keyword-classified) |
| `needs_review` runs | ≤ 3% of runs | needs_review ledger ÷ scheduler run sidecars |
| Wasted runs (verdict neither clean nor completed-equivalent) | ≤ 5% of runs | scheduler run sidecars (per-run verdict) |

**Freeze rule.** Until the target holds for **2 consecutive weeks**, scheduler/develop-loop PRDs
are limited to bug fixes, deletions and measurement. A PRD that adds a new mechanism must name
the existing mechanism it deletes. A red week (any measure missed) re-arms the freeze and resets
the consecutive-week count to 0.

**Who checks.** The architect Epic, before queuing any scheduler/develop-loop work: compute the
four measures for the last full week from the sources above, state whether the freeze is armed,
and reject or reshape PRDs that violate it.

## 1. The dispatch path — what actually drives `tickQueue`

`tickQueue()` (`src/main/scheduler.cjs`) is the single function that reads the queue,
runs every gate, and fires `spawnJob` for the next batch. It is a serialized promise tail
(`tickTail`) so concurrent callers never race the same pending rows. **There is no bare
timer that calls it directly on a fixed cadence** — every call is a reaction to one of:

- **A job finishing.** `spawnJob`'s own `finally` block calls `tickQueue()` on every exit path
  (success, failure, park) — the primary driver in a busy queue.
- **The billing poll loop.** `pollLoop()` re-arms itself via `setTimeout` and, on *every* branch
  (success, 429, auth failure, transient error) calls `maybeLaunchWhenAvailable(state)`,
  which ticks when `firePolicy === 'when-available'`, the queue is not paused, and work is
  pending. It does not check the threshold itself: `tickQueue` applies the usage hold to this
  tick like every other automatic tick (see "Usage threshold vs rate_limit pause", §7). A poll
  does **not** need to succeed to trigger a tick.
- **The starvation watchdog**, forced from the 60s heartbeat timer, independent of the poll loop
  — see §3.
- **A human** — only **Run now** and **Fire next batch now** (the `schedule:run-now` and
  `schedule:force-tick` IPC handlers) call `runDueJobs({ bypassLoadGate: true, human: true })`,
  bypassing the load gate and the usage hold. The resume timer (`clearPause('resume-timer')`),
  boot-elapsed and drain-abort `runDueJobs()` calls are automatic: defaults, no load-gate bypass,
  and the usage hold applies (§7). The only other load-gate bypass is the starvation watchdog's
  last-resort forced tick (§3) — automated, but the same rationale: dispatch when nothing else will.
- **A slot freeing up** — `sessionSlots.subscribe(() => tickQueue())` (registered in `init()`)
  fires on every `release()` and on `setCap()` raising the pool.
- **`reapDeadRunningJobs()` finishing its sweep** — ticks once more after finalizing dead rows.

### `lastRunAt` vs `lastDispatchAttemptAt`

Two different claims, both machine-wide fields on `scheduler-machine.json`
(`shapeMachine`, `src/main/lib/scheduler/queueStore.cjs`):

| Field | Stamped | Proves |
| --- | --- | --- |
| `lastDispatchAttemptAt` | Inside `tickQueue`, the FIRST thing after the paused/unreadable/cancelled guards | The engine reached the picker this pass — regardless of whether anything launched |
| `lastRunAt` | Inside `tickQueue`, only after slots/memory/load gates all passed and a batch is about to spawn | A batch actually launched |

The starvation watchdog (§3) deliberately keys off `lastDispatchAttemptAt`, not `lastRunAt`
(inside `runQueueStarvationWatchdog`, §3) — a poll that keeps "succeeding" while never reaching the picker would otherwise look
falsely fresh. **A stale `lastRunAt` with a fresh `lastDispatchAttemptAt` means the queue is
being evaluated and has nothing to fire (healthy-idle); a stale `lastDispatchAttemptAt` means
the ticking mechanism itself has stopped being invoked (the real stall).**

## 2. The slot pool — the one machine-wide concurrency cap

`src/main/lib/scheduler/sessionSlots.cjs` is the ONLY concurrency limit the picker answers to
(`tickQueue`'s slot gate in `scheduler.cjs`; its comment confirms a former private `concurrencyCap` of 3 was retired
in favor of this pool — see commit `4c8916d`).

- `MAX_SLOTS = 10` (`sessionSlots.cjs`) — hard ceiling.
- `DEFAULT_SLOTS = 5` — effective default, user-adjustable `[0, 10]` from the Home tab,
  persisted to `~/.claude/session-manager/session-slots-config.json` (`setCap`/`readPersistedCap`); `SM_SESSION_SLOTS` env overrides everything.
- `acquire(owner)`/`release(token)` are a token-paired map; a stuck holder is
  attributable via `snapshot()`.
- **A `config.concurrencyCap: 4` (or `3`) field may still be sitting in a stale
  `scheduler-machine.json` on disk — it is vestigial.** `shapeMachine` doesn't strip unknown
  fields, but no dispatch code reads `config.concurrencyCap` after `4c8916d`. Don't diagnose a
  slot ceiling off that field; read `sessionSlots.snapshot()` (`scheduler_list_jobs` / `npm run
  health`) instead.
- A **separate, secondary** cap exists per job/Epic worktree (`src/main/lib/git/gitWorktree.cjs`,
  `getMaxConcurrentWorktrees`) — the job-kind default is floored at
  `sessionSlots.totalSlots()` so raising the slot pool can never silently strand jobs without
  worktree isolation. Its in-memory counter (`activeWorktreeCount`) is **self-healing**:
  `reserveWorktreeSlot` re-verifies a would-be rejection against the real on-disk
  worktree count (`getObservedWorktreeCount`) before honoring it, correcting a leaked
  (never-decremented) counter down to reality rather than wedging the cap at a stale high-water
  mark for the rest of the process's life.
- A fresh job worktree gets the main checkout's gitignored dependency dirs via `linkDependencyDirs`
  (`src/main/lib/git/worktreeDeps.cjs`, called from `gitWorktree.cjs` right after the worktree is
  created): `node_modules`, `.venv` and `venv` are symlinked in when they exist and are gitignored in
  the main checkout, and each linked name is appended as `/<name>` to the repo's shared
  `info/exclude` (a `node_modules/` gitignore line matches directories only, so the symlink would
  otherwise show as untracked and park the job `uncommitted_changes`). Exceptions that get their own
  copy instead of a link: pnpm `node_modules` (offline frozen install) and a uv project's
  `.venv`/`venv` (offline frozen `uv sync` — a shared env lets one worktree's `uv run` repoint the main
  checkout's editable install at its own `src/`). Best-effort: it never fails
  worktree creation. Then the project's `worktreeSetup` commands (tracked `.session-manager.json`,
  `lib/git/worktreeSetup.cjs`) run with cwd = the worktree root, one at a time per project and never
  skipped; the outcome is the `[scheduler] worktree setup:` lines atop the run log and `worktreeSetup`
  in meta.json. Kill switch `SM_WORKTREE_DEP_LINK_DISABLE=1` skips both the linking and the setup.

## 3. The starvation classifier — the last-resort safety net

`classifyQueueStarvation` (`scheduler.cjs`) answers one question: *there is pending
work — is anything actually going to run it?* It returns `null` (healthy) when paused, when
something is already running, when there's no pending work, or when idle time is under
`QUEUE_STARVATION_MS` (10 min). Otherwise it classifies:

- **`'starved'`** — at least one pending row is not behind a blocked `dependsOn` chain. A tick
  would help.
- **`'blocked'`** — every pending row is behind a terminal/parked dependency. Ticking cannot
  help; this needs a human or a heal pass.

`classifyQueueStarvationByProject` runs that check **per project cwd** rather
than machine-wide — a single long job in one project used to disarm the watchdog for every
other project (2026-09-12 incident, comment just above it).

`runQueueStarvationWatchdog`, called every 60s from the heartbeat timer
independently of the billing poll loop, is the action half: it logs+audits one event per
starved/blocked project, and — if anything is `'starved'` — force-clears a stuck `cancelToken`
("the watchdog must be able to un-wedge this too") and forces exactly ONE machine-wide
`tickQueue({ bypassLoadGate: true, lastResort: true })` near the end of the function, per pass. On a saturated CPU (the sample proves it; a null sample or the 50-85% band does not count) the bypassed tick launches exactly one job and writes a `load_gate_last_resort` audit row; a human Run now keeps the whole batch. The bypass is
load-gate-only: a `'starved'` verdict means pending+dispatchable rows with ZERO running for
≥10 min, so a high `loadavg` is coming from *another* process the scheduler can't influence —
holding the last-resort tick behind it froze the queue for hours (2026-09-23: `load-deferred`
unbroken 07:00→13:06). The slot pool and memory gate — the guards for real exhaustion — are
NOT bypassed and still bound the forced batch; only the advisory CPU-headroom gate is skipped,
exactly as a human Run-now (§2) skips it.

### The CPU load gate (`lib/scheduler/loadGate.cjs`)

Runs last in the gate order (slots → per-project cap → memory → load) and only withholds launches.
The decision: **hold when `loadavg1` per core is over `LOAD_GATE_PER_CORE`**, then pick a band by the
CPU busy fraction of a ~1-minute sample (`cpuSample.cjs`; `MOSTLY_IDLE_BUSY = 0.5`, `SATURATED_BUSY = 0.85`):

- **Under half busy: stands down** at once (`loadavg` counts D-state tasks and short bursts, so it can read high on an idle CPU).
- **Half to 85% busy: holds**, and after 45 minutes (`JOB_OVERRUN_FLOOR_MS`) one job goes through (`load_gate_yielded`) because capacity remains.
- **85% and up: the gate itself holds and never launches**, because launching there is what the gate exists to prevent. A human Run now bypasses it with the full batch; the starvation watchdog bypasses it with one job (`load_gate_last_resort`). Every 45 minutes it writes a `load_gate_escalated` audit row and a toast for a human.

**What can still start work at 85% busy or more.** "The gate holds" means the normal batch path launches nothing, not that nothing launches. Five paths remain: a human Run now (the full batch); the starvation watchdog (one job); periodic resume recovery (one row per pass, `selectResumeRecoveryBatch(jobs, { saturated })` in `reviewLadder.cjs`; the rest wait for the next pass); same-tick resume recovery (one per finished job); and the auto-fix investigation (one machine-wide). Mechanical recovery runs git only, so it starts no claude session and is not on this list.

**Reconcile coverage rule.** `reconcile()` skips PRDs of any project whose queue file the read did not cover, for that pass only: it writes a `reconcile_uncovered_project` audit row (`cwd`, `skippedPrds`) and the next read, which covers the project, mints them. A project missing from a read is never treated as having an empty queue.

**The busy fraction is net of this app's own processes** (PRD 3495). On 2026-11-22 the gate held
launches at ratios 2.21, 1.86, 1.23 and 1.01 (threshold 0.85, 14 cores) while the app's own renderer
averaged ~81% CPU and main ~45%: about 1.26 cores, or 9 points of a 14-core box that the gate counted
against itself. `cpuSample.cjs` `readOwnProcessTicks` now reads `/proc/<pid>/stat` for Electron main
plus each descendant with the same executable and an Electron `--type=` flag (zygote, renderer, GPU,
utility). Spawned `claude -p` jobs have no such flag, so they still count. All three bands judge
`cpuBusy` = **net**. Audit rows carry `cpuBusyRaw`, `cpuBusyNet` and `cpuOwnBusy`. `loadavg` is still
the first predicate and is still reported, but it never holds alone when net busy is under the idle
bar. Off Linux there is no own reading, so net = raw. Measured 2026-11-22 10:16 AM PST with a bounded
60 s `/proc` script against the live app (8 own pids, 4 jobs running, loadavg1 2.61→2.05, so ratio
≈0.17: the gate was not firing): **raw 6.3% → net 4.4%**. Own share was 1.9%, i.e. 0.27 cores (main 0.25,
renderer 0.02, GPU/utility/zygote ~0). The renderer was idle in that window. At the incident's 1.26
cores the net figure drops by ~9 points.

**No sample yields at the limit**: it cannot prove saturation, so loadavg alone holds until 45 minutes, then one job goes through. A broken reader must never disable the gate.

`iowait` does NOT count as busy: it is an idle CPU with I/O outstanding, swap-in waits land there on
this host, and the memory gate and swap clamp run first and own that problem. It is recorded as
`cpuIowait` in the audit rows. `nice` still counts as busy: every Session Manager process runs at
nice 12, so nice is the largest column on this box; leaving it out would read a fully loaded machine
as idle.

**When a hold ends.** A hold ends when a launch was actually issued, or nothing is waiting (paused,
draining, empty batch). Slots-exhausted and memory-deferred ticks do NOT end it.

**Reading a hold.** A heartbeat's `dispatch.lastTickReason` is the LAST tick only, and a gap in
gated ticks means slots or memory was the limiter. To size a hold, count heartbeats per reason over
the window. Example, 2026-10-31 18:01-18:55 PDT: detail said `held for 53m`, but of 54 heartbeats
`slots-exhausted` was 29, `memory-deferred` 13, `load-deferred` 11, the longest unbroken
`load-deferred` run was 6 minutes, and 7 jobs launched. The 53 minutes was a clock, not a hold.
`loadRatio` from `health.cjs` is the raw loadavg figure with no CPU sample behind it, so it can
read over threshold while the gate stands down. Health's `scheduler_queue` now carries `lastTickReason` and
`lastTickDetail` beside the raw `loadRatio`; read those for what the gate decided.

## 4. The `needs_review` recovery ladder

Six named rungs, defined once as the closed set `LADDER_RUNGS`
(`src/main/lib/scheduler/needsReviewLedger.cjs`) and classified from the `source` string every
`transitionJob` call carries (`classifyLadderRung`). The gauntlet at
the same-tick park path in `scheduler.cjs` (`transitionJob` callers) tries rungs 1-3 same-tick, immediately on park; rung 4 fires same-tick
if 1-3 don't apply; rung 5 (`reverifyNeedsReview`) is the periodic catch-all for anything the
same-tick path missed (app restarted mid-episode, etc.) — it re-runs the SAME selectors, not a
different algorithm.

A needs_review park is the scheduler's self-heal state; the UI never presents it to the human as a question ([`needsHuman.ts`](../../src/renderer/lib/needsHuman.ts)).

| # | Rung | Entry condition | Exit |
| --- | --- | --- | --- |
| 1 | **mechanical-recovery** | `selectMechanicalRecoveryTarget`: `verifierVerdict === 'worktree_integration_failed'` (the one verdict PRD 1125 already taught `integrateBranch` to auto-resolve on retry) and not yet attempted. Kill switch `SM_MECHANICAL_RECOVERY_DISABLE=1`. | `performMechanicalRecovery` re-attempts `integrateJobBranch` — pure git, no model call. Success → `completed` (source `scheduler:mechanicalRecovery`). Failure → stays `needs_review`, `mechanicalRecoveryAttempted=true` stamped either way (one bounded attempt, falls through to the next rung). |
| 2 | **resume-recovery** | `selectResumeRecoveryTarget`: `verifierVerdict === 'uncommitted_changes'`, a live `sessionId`, non-empty `uncommittedPaths`, not yet attempted. Kill switch `SM_RESUME_RECOVERY_DISABLE=1`. | One bounded `claude -p --resume <sessionId>` dispatch asking the SAME session to finish its own commit — falls through ordinary `spawnJob` finalize (park/fail/complete again). |
| 3 | **quarantine** | `selectLeftoverQuarantineTarget`: resume recovery already spent AND the job parked `needs_review`/`uncommitted_changes` again, excluding any path already dirty pre-run (`preRunDirtyPaths`) — never touches foreign WIP. Kill switch `SM_LEFTOVER_QUARANTINE_DISABLE=1`. | `quarantineLeftovers`/`performLeftoverQuarantine` commits the job's own leftovers onto a throwaway `sm-salvage/<slug>` ref (never `git stash`) and restores the shared tree to baseline. **The row itself stays `needs_review`** — no `transitionJob` call site resolves it directly; the tree being clean again is what lets a LATER worktree merge for this project succeed. |
| 4 | **auto-fix** | `isEligibleForImmediateAutoFix`/`selectAutoFixTargets`: not resume/mechanical-eligible, has a `runId`, under `isFixPlanBeyondDepthCap`, one bounded retry (only if the prior `autoFixOutcome` was `'no-plan'`/`'error'`/unset). Capped machine-wide by `MAX_CONCURRENT_INVESTIGATIONS=1`. | `spawnInvestigation` launches a **fresh-context** `claude -p` that authors a `fix-<slug>.md` PRD. Source `spawnInvestigation:start`; the fix-plan's own success promotes the original via `transitionJob(orig, 'completed', {source: 'spawnJob:auto-promote'})`. |
| 5 | **reverify** | `reverifyNeedsReview()` (`scheduler.cjs`), run once on boot and every 10 minutes (`shouldRunPeriodicReverify` gate) via `rescheduleInterval`. Re-runs the verifier over stale `needs_review`/`failed` rows and computes a `looksDone` annotation (a later commit touching the PRD's declared paths). | Genuinely stale + still-passing verdict → `completed` (source `reverifyNeedsReview:heal`). A row with `looksDone` but no direct heal path is left for rung 6. |
| 6 | **bounded auto-resolve / manual-reset** | `applyNeedsReviewAutoResolve`, gated by `selectExhaustedNeedsReviewTargets`: an exhausted-auto-fix, guard-parked, stranded-auto-fix, or fix-plan row (fix plans never enter auto-fix, so they need no `autoFixAttempted`) that has sat `needs_review` for `NEEDS_REVIEW_RESOLVE_MS` (30 min). | `looksDone` → `completed`. Otherwise up to `NEEDS_REVIEW_RESOLVE_CAP=2` requeues to `pending`; the cap-exhausted pass auto-`skip`s the row (`needsReviewAutoResolvedSkip`) so a `dependsOn` chain behind it still drains. Anything not matching one of the sources above (an explicit human `scheduler_reset_job`) buckets as `manual-reset` in the ledger. |

Gate authority is not a seventh rung. It runs inside the shadow gate (`runGateShadow`) that rung 5
already fires in the background, decided by `decideGateAuthority` (`lib/scheduler/gateAuthority.cjs`). A
needs_review park with verdict `transcript_errors`, `no_verdict_sentinel` or
`abandoned_background_task` completes on its own when the gate re-run is green, the landed commit is
on HEAD, and the tracked tree is clean. Kill switch: `SM_GATE_AUTHORITATIVE_DISABLE=1`. Every other
verdict keeps the shadow gate observation-only, exactly as before.

**Baseline extension.** A park with verdict `sentinel_fail` whose gate is red at HEAD can also
complete when the gate was already red before the job (`decideBaselineAuthority`,
`lib/scheduler/baselineGate.cjs`, run from the same shadow gate). The base is the job's
`guardHeadBefore`; `runGateShadow` runs the PRD gate there in a scratch detached worktree (deps
linked via `linkDependencyDirs`, removed afterwards, memoized per HEAD on `gateShadow.baseline`). The scratch also runs the project's `worktreeSetup`; its outcome is recorded on `gateShadow.baseline.setup`, and a base whose declared setup did not pass is unavailable (`base-setup-<reason>`).
Failing-id subset rule: both runs must fail the same gate step, and every failing test id at HEAD
(`parseFailingTests`) must also fail at base — one new failing id, an unparseable output, or a green
base refuses. Last, the run's recorded FAIL reason (the verdicts sidecar `reason`) must name one of
the excused failures (an id or its file part); otherwise it refuses `fail-not-about-gate`, so a FAIL
on an outside blocker over an already-red suite stays parked. The landed-commit evidence, on-HEAD, clean-tree and HEAD-stable checks are the same as
above. Success completes the row with verdict `pass_preexisting_gate_red` (ids in
`preexistingGateFailures`, named in the completion notice); the decision and its `reason` are
recorded at `gateShadow.baseline`. Kill switch `SM_BASELINE_GATE_AUTHORITY_DISABLE=1`.

**No `needs_human` verdict.** It no longer exists (a legacy `NEEDS_HUMAN` line reads as FAIL); every park goes through the same ladder.

## 4b. Preflight holds — waiting on a person, not a park

A PRD's optional `preflight` (authoring rules: [`PRD_AUTHORING.md` §6](../../src/main/templates/PRD_AUTHORING.md#preflight); runner: `lib/scheduler/preflightCheck.cjs`) names an external precondition a person controls.

- **Dispatch hold.** Before launch, `runPreflightGate` (`scheduler.cjs`) runs it (no shell, 60 s cap). Red → the row stays `pending` with a `preflightHold` (`since`, `attempts`, `nextAt`, `lastExit`, `lastOutputTail`, `failText`) and `heldReason` `waiting on precondition: <cmd> exited <code> — re-check at <nextAt>`; `computePreflightHolds` keeps the picker off it, and dependents see it as a blocking dep. Audit `preflight_hold`; green clears both fields, audit `preflight_pass`.
- **Backoff.** Re-checks at 10, 20, 40, 60 min, then hourly (`preflightDelayMs`). No model call while held.
- **Reroute.** A run that ends `SCHEDULER_VERDICT: FAIL` re-checks its preflight once. Red → back to `pending` with a fresh hold (source `scheduler:preflight-hold`, audit `preflight_hold` with `after: 'sentinel_fail'`) instead of a `needs_review` park, so the [§4 ladder](#4-the-needs_review-recovery-ladder) and auto-fix never run on it. Green or a check error → the ordinary park.
- **Reset = re-check now.** `resetJobFields` drops `preflightHold` and a `waiting on precondition:` `heldReason`, so the next tick re-runs the preflight.
- **One immediate notice.** Each hold (keyed by slug + `since`) sends one informational Epic message, `notice: 'preflight-hold'`, starting `PRECONDITION HOLD:` — what is missing, the command, the held PRDs, the next re-check. It asks nothing and is not a grouped needs_review notice.
- **Starvation naming and suppression.** `project_starved` warnings, audits and escalations name the root blocker (`rootBlockingSlug`/`rootBlockingStatus`/`rootBlockingReason`, from `starvation.rootBlockersForProject`). When every pending row is preflight-held or waits on a preflight-held root (`starveRootFor` → `knownWait`), the project is waiting, not starved: no warning, audit or escalation.

## 4a. Validation messaging into the Epic

The scheduler never prompts the planning session per finished PRD. Instead:

- **Settle trigger.** Every terminal (completed/failed) check-in arms a per-Epic in-memory
  debounce timer (`SM_EPIC_SETTLE_SECONDS`, default 120). When it fires and the Epic has no
  pending or running PRD, the Epic is settled.
- **Sweep.** Completed non-validator PRDs since the last digest (24-hour horizon) with no
  VERIFIED/REFUTED verdict get one scheduler-queued headless validator, slug
  `validate-sweep-<yyyymmddhhmmss>` (stamp has seconds), at most 25 PRDs each. Its budget is
  sized from the gates: every covered PRD's gate at its own timeout, plus 15 minutes. A sweep
  that would pass the job-budget ceiling is split: one sweep runs at a time, and the carried
  PRDs get the next. A single PRD over the cap runs budget-exempt under the 4-hour deadman.
  Sweep guard: a slug already in a sweep validator's `dependsOn` is never swept again.
- **Digest.** When nothing is left to sweep, ONE chat prompt starting `PLAN SETTLED` lists
  Verified, REFUTED, Failed, Parked and Not validated. A digest marker event (outcome `digest`,
  `digestKey`) dedups a repeat for the same state. Not validated appears only when the validator
  persona could not be queued or a sweep already ran without checking a slug.
- **Kill switch.** `SM_EPIC_VALIDATION_DISABLE=1` turns all of it off.
- **No boot-time sweep.** The timer is in memory; a boot sweep would message every active Epic at
  once. needs_review grouped notices (§4) are unchanged.

## 5. The reap/orphan path and its git-evidence gate

`reapDeadRunningJobs()` (`scheduler.cjs`) scans `queue.json` (never the in-memory
`runningSet` alone — a swallowed mutate error can desync the two) for `running` rows whose
`claude` process is provably dead, or whose spawn never recorded a `runtime.pid` at all
("pidless"). Before finalizing any such row to `'failed'`, it now consults
**`resolveLandedCommitEvidence(cwd, sha, sinceIso)`** — a bounded `git cat-file -e
<sha>^{commit}` plus a `git log -1 --format=%cI` timestamp check bounded to the row's own
`startedAt` (so a stale `landedCommit` surviving from an earlier dispatch of the same slug can
never falsely promote a LATER real failure). A row whose commit resolves gets promoted to
`completed` (source `reapDeadRunningJobs:landed`) instead of `failed`.

Pidless recovery (`findLiveProcess`, audit event `job_pid_recovered_by_liveness_scan`) adopts a
process only when its `/proc/<pid>/cmdline` argv[0] is a `claude` binary (`isClaudeArgv`,
`reaperHelpers.cjs`) AND the row has a run log; a pid already held by another running row, or
already adopted earlier in the same pass, is never adopted again (the pass warns naming both
slugs). There is no cwd-based match.

This gate was added in commit `44c3604` after job 1192 shipped a real, verifiable commit and
was still reaped `failed` because the reaper only ever judged spawn bookkeeping
(`runtime.pid`), never the `landedCommit` a row could already carry.

## 5a. Landing — linear by default, and every case that can still write a merge commit

Every job and Epic branch lands on its base branch (`baseBranch`, else `resolveDefaultBranch`) through
`integrateBranch` (`gitWorktree.cjs`), linearly, because consuming projects' tooling can refuse merge commits
(Bilko's `scripts/sync-local-main.sh` exits 3 on any merge commit in `origin/main..main`). Both paths' linear
step is `replayBranchOnto`: a checkout-free replay (`git merge-tree --merge-base` + `git commit-tree`) of the
branch's **non-merge commits only** (`rev-list --no-merges`) onto the base tip — author and message kept,
already-applied or emptied commits skipped, more than 200 refused. A merge commit in the branch is never replayed, so
when the replayed range holds one the replayed tip's tree must equal the tree `git merge-tree --write-tree <base> <branch>`
writes, or the replay refuses with `branch_has_merges` rather than drop that merge's content.

**In-checkout — `integrateBranch`, when `cwd`'s HEAD is on the base branch.** Callers: the scheduler job first-pass
integrate (`finalizeJobWorktree` → `integrateJobBranch`), the Epic `markCompleted` merge (`epicWorktreeMerge.cjs` →
`integrateEpicBranch`), mechanical recovery (§4 rung 1) while HEAD is on the base, and `branchSweep.cjs`'s stranded-branch sweep.

1. `git merge --ff-only` → `fastForward: true`.
2. `replayBranchOnto` onto HEAD, then `git merge --ff-only` of the replayed tip; up to 3 attempts
   (`MAX_LINEAR_ATTEMPTS`), replaying again when HEAD moved under the ff → `linear: true`, `replayedCommits`.
   Any other failure here (e.g. the 200-commit cap) returns `failureKind: 'other'` and writes no merge.
3. `git merge --no-ff` fallback (`merge scheduler job <slug>` / `merge epic <epicId>`), only for a `linearFallback`
   reason in the table below → `mergeCommit: true`, `linearFallback`. A conflicted fallback whose paths are all
   pure additions to `.md`/`.markdown`/`.txt`/`.rst` files is concatenated (`autoResolved: 'pure_addition_concat'`).
4. Abort-and-flag on a real conflict: `git merge --abort`, `ok: false` (`content_conflict` + `conflictedPaths`);
   the branch is kept (job → `needs_review`, Epic → `needs_merge_resolution`).

**Onto-ref — `integrateOntoRef`, when HEAD is on another branch.** Only mechanical recovery reaches it:
`performMechanicalRecovery` passes `allowRefLanding: true` (kill switch `SM_REF_LANDING_DISABLE=1`), so
`integrateBranch` lands straight onto `refs/heads/<base>`, touching no checkout; a detached HEAD, or a branch that
only touches carried paths, is refused instead. Each attempt first refuses (`target_checked_out`) when that ref is
checked out or mid-rebase in any worktree.

1. CAS fast-forward (`git update-ref <ref> <branch tip> <old tip>`) → `fastForward: true`.
2. `replayBranchOnto` onto the ref tip, landed by the same CAS → `linear: true`, `replayedCommits`.
3. Two-parent merge fallback (`git merge-tree --write-tree` + `git commit-tree -p <ref tip> -p <branch tip>`,
   same CAS) → `mergeCommit: true`, `linearFallback`.
4. `content_conflict` refusal when that merge-tree conflicts — the ref is untouched.

A lost CAS recomputes from scratch; 3 losses end in `ref_race` and nothing lands. `integrateBranch` passes a
landing through with `viaRef: true` (mechanical recovery logs `landed onto the base ref directly`) and
reports every failure except `content_conflict` as the original `stray_checkout` refusal.

**Every case that can still put a merge commit on the base branch.** Each fallback first prints one `console.warn`
to Electron's stderr, which the launcher saves as `electron-stderr.log` in the app's `logs/` directory:

```
[gitWorktree] linear landing of <branch> fell back to a merge commit (<linearFallback>)
[gitWorktree] linear landing of <branch> onto refs/heads/<base> fell back to a merge commit (<linearFallback>)
```

| Case | `linearFallback` (the warn's `(…)` suffix) / trigger | What lands |
| --- | --- | --- |
| `SM_LINEAR_LANDING_DISABLE=1` | `'disabled'` | Every diverged landing takes the merge fallback, both paths |
| git older than 2.40 (the replay needs `merge-tree --merge-base`) | `'git_too_old'` | In-checkout: the `merge --no-ff` fallback. Onto-ref: the merge fallback, which itself needs git 2.38 or newer (`merge-tree --write-tree`); on older git nothing lands |
| A replay conflict the pure-addition auto-resolve (`resolvePureAdditionInTree`; off under `SM_PURE_ADDITION_MERGE_DISABLE=1`) cannot settle | `'content_conflict'` | A merge commit when the whole-branch merge is clean (in-checkout, also when its pure-addition concat settles it); otherwise abort-and-flag or the `content_conflict` refusal |
| In-checkout only: HEAD moved under all 3 replay attempts | `'ref_race'` | The `merge --no-ff` fallback (an onto-ref `ref_race` lands nothing) |
| A merge commit already inside the branch — e.g. a conflict resolved with `git merge` in an Epic worktree after the "merging it is yours to do in git" banner | The base is an ancestor of the branch tip: `fastForward: true`, no `linearFallback`, no warn | A fast-forward carries it as-is, both paths. A moved base now falls back (next row) instead of replaying the merge away. Check `git log --merges <base>..<branch>` before landing |
| The base moved and the branch holds merge commits whose content a linear replay would not reproduce: the replayed tip's tree differs from `git merge-tree --write-tree <base> <branch>`'s, or that merge-tree conflicts | `'branch_has_merges'` | The merge fallback, both paths, after the warn line: in-checkout the `merge --no-ff`, onto-ref the two-parent merge. A merge whose content the replay reproduces exactly (e.g. a clean merge of the base) still lands `linear: true` |

**Consumer check.** `git log --merges origin/main..main` stays empty unless a `fell back to a merge commit` line was
logged, a fast-forwarded branch already held a merge commit, or someone merged by hand in the checkout. A fallback
merge is titled `merge scheduler job <slug>` or `merge epic <epicId>`; any other title came in inside a branch or by hand.

## 6. The launch circuit breaker

Full narrative + operator guidance already lives in
[`scheduler/README.md`](../scheduler/README.md#launch-circuit-breaker-non-runs-are-not-failures)
— read that first. The mechanics, in `src/main/lib/scheduler/launchFailure.cjs`: a state machine keyed by
launch persona (`launchBlockKeyFor`, keyed on `agentType`) — **closed → open/blocked
(exponential backoff, `armLaunchBlock`, capped at `BACKOFF_CAP_MS=1h`) →
half-open/probe (exactly one job through once backoff elapses, `evaluateLaunchGate`)
→ closed again on a real turn** (`resultShowsRealTurn`). `LAUNCH_BLOCK_MAX_ATTEMPTS
= 8` after which the block stays open indefinitely until the CLI version changes or a
human clears it via Resume/Run now.

## 7. Diagnosis table

| Symptom | The ONE thing that distinguishes it | Expected remedy |
| --- | --- | --- |
| Pending rows, nothing running, queue looks frozen | `scheduler-machine.json`'s `lastDispatchAttemptAt` — fresh (< 10 min) means the engine is evaluating and has nothing to fire; stale means dispatch itself stopped being invoked | Fresh: wait, it's healthy-idle or gated (check `heldReason`/load gate). Stale: **automatic** — the 60s heartbeat's starvation watchdog (§3) force-ticks within 10 min; if it hasn't, `npm run health`'s `queue_dispatch`/`scheduler_queue` components are non-GREEN and name the cause |
| A `dependsOn` chain stalled behind one row | That row's `status` — if `needs_review`, check `job.exhaustedResolveAttempts` and how long it's dwelt (`statusHistory`'s last `to: 'needs_review'` entry) | If under 30 min: **automatic**, the ladder (§4) is still working through it. If exhausted (`exhaustedResolveAttempts` at cap): **automatic** — auto-skips within one more pass to unblock the chain. `blocked` (not `starved`) verdicts from §3 need a human |
| Slots saturated by an overrunning job | `sessionSlots.snapshot()` (via `scheduler_list_jobs` or `npm run health`) — `holders` names the owner; check the row's `budgetWarning` field (stamped at 75% of budget, `scheduler.cjs`) and `job.verifierVerdict === 'budget_exceeded'` | **Automatic, and tighter than the 4h deadman**: the wall-clock BUDGET watchdog (`computeJobBudgetMs`) SIGTERMs a job once elapsed time passes `clamp(estimateMinutes × 3, 45min floor, 180min ceiling)` — calibrated against a p50=13m/p90=60m/max=240m run-duration profile — well before `MAX_JOB_DURATION_MS`'s 4h deadman would ever fire. A budget kill always parks `needs_review` with `verifierVerdict: 'budget_exceeded'` (`classifyBudgetKill`,) and is deliberately excluded from rungs 1-4 of the ladder — it only clears via rung 5/6 or a human. A budget-killed validator also arms the settle, so it no longer waits for a human |
| Pending row held with `heldReason: 'files-overlap:<slug>'` | The named row is `running` (or picked earlier this tick) in the SAME project and its `files` array shares an equal path or a folder (`/`-suffixed) prefix with this row's | **Automatic** — mutual exclusion only (`schedulerBatch.cjs`), imposes no order; releases on the first tick after the named row leaves `running`. Rows with empty/missing `files` are never held; other projects never interact. Wrong when it never clears: the named row is stuck `running` — diagnose that row |
| Torn `scheduler-machine.json` | `npm run health`'s `scheduler_queue.machineStateRecovered` field, or a `queueStore.recoverTornMachineState*` WARN/ERROR in logs | **Automatic** — `findLongestValidJsonPrefix` (`queueStore.cjs`) recovers the longest valid prefix and dispatch keeps running; health only goes non-GREEN as a loud "this happened" signal. A prefix mentioning `paused`/`resumeAt` in its discarded tail needs a human to verify pause status manually |
| Job parked `needs_review`, verdict `sentinel_fail`, reason says pre-existing failures | `gateShadow.baseline.reason` on the row (`baseline-identical` completes; `new-failures`, `different-failing-step`, `base-green`, `unparseable-output`, `base-unavailable`, `base-setup-<reason>`, `kill-switch`… refuse; setup outcome at `gateShadow.baseline.setup`) | `new-failures`: the job broke something — fix it. `base-unavailable`/`base-setup-<reason>`/`unparseable-output`: the base gate could not be judged; re-run by hand at `guardHeadBefore`. Otherwise see the baseline extension in §4 |
| Leaked worktree-cap counter (rows held `pending` with `heldReason: 'worktree cap reached...'` and 0 running) | `npm run health`'s `scheduler_queue.worktreeCapBlocked` (`health.cjs`, keys on `runningCount === 0` + the exact `heldReason` prefix) | **Automatic** — `reserveWorktreeSlot` (`gitWorktree.cjs`) re-verifies against the real on-disk worktree count before honoring a rejection, self-correcting a leaked in-memory counter without an app restart |
| A job's worktree was stranded (process died, checkout never cleaned up) | Directory age under the kind's worktree root vs `getStaleSweepAgeMs` (job: 24h, epic: 7d, `gitWorktree.cjs`) | **Automatic** — `sweepStaleWorktreeCheckouts` runs on boot (`reconcileWorktreesOnBoot`) and periodically, but only reaps past the age threshold AND only when no `/proc` process still holds the directory as its cwd (`hasLiveHolder`) — a still-running job is never torn down early |
| Job parked `needs_review`, verdict `worktree_integration_failed`, `integrationFailureKind: 'content_conflict'`, its own verifier said clean, `filesChanged: 0` but a real `landedCommit` | `git log --oneline main..sm-job/<slug>` shows unmerged commits | Merge the preserved branch by hand, then archive the PRD. Rung 1 skips it (without spending its attempt) while base HEAD is unchanged since the failure (`integrationBaseHeadSha`); pure-addition doc conflicts are auto-resolved at merge time (kill switch `SM_PURE_ADDITION_MERGE_DISABLE=1`) |
| Job parked `needs_review`, verdict `worktree_integration_failed`, reason `refusing to integrate: branch adds app runtime state` | The run committed a file under a runtime folder (`session-manager-operations/<ns>/`, ns from `RUNTIME_NAMESPACES`); the paths are in `runtimeStatePaths`, the branch `sm-job/<slug>` is kept | Re-land the work without that file (cherry-pick the branch, `git rm --cached` the listed paths, commit); never force-add it |
| Job parked `needs_review`, verdict `worktree_integration_failed`, `integrationBaseRewritten: true` | The base branch was rewritten (rebased/reset) while the job ran, so its fork commit is no longer an ancestor of HEAD; the reason and `integrationConflictPaths` name the paths | A base rewrite normally lands only the job's own commits (fork..branch replayed onto the new HEAD, never a merge of the old history). This park means that replay failed: merge the listed paths by hand from `sm-job/<slug>` onto the base, then archive the PRD |
| Job parked `needs_review`, verdict `reaped_without_integration` | The reaped run's log has no `SCHEDULER_VERDICT: PASS` line of its own, and its `sm-job/<slug>` branch (named in the reason) still holds commits HEAD lacks | An adopted run that did print its own PASS line is landed by the reaper (fork-bounded, same as a normal finish), and the boot sweep keeps an adopted run's checkout for the reaper; only runs without a PASS line park here. Review the branch, land it by hand if the work is good, then archive the PRD |
| Job parked `needs_review`, verdict `run_commit_not_landed` | The run committed on a detached HEAD or a branch that never reached the base; the commit is pinned under refs/sm-stranded/. List pins: `git for-each-ref refs/sm-stranded` | Means the work exists but never landed. The auto-fix investigation re-lands the commit (its fix plan cherry-picks the pinned commits oldest first, runs the gate, re-implements only what does not apply). Fallback, if that fails: a human lands one with `git cherry-pick <sha>` on the base branch, then archives the row. `pass_no_commit_already_shipped` is historical and no longer emitted; old rows may still carry it |
| Job completed with verdict `pass_no_commit_artifact_verified` | Sidecar `<slug>.verdicts.json` `verifiedArtifacts` (path/size/mtime) | Means: the PRD declared `deliverable: artifact` + `artifactPaths`, exit 0, truthful PASS, no commit, and each declared file exists (under `queueEntry.cwd`, else the run worktree), is a non-empty regular file, and has an mtime in start−60s..finish+120s; the commit guard additionally required zero newly-dirty tracked files. Wrong when: the artifact is a stale file the run merely touched within the window, or the declaration lists a path the PRD never needed to write — the check is presence+freshness, not content. Completed-equivalent; never parks, so no `RESCANNABLE_VERDICTS` change |
| Epic shows 1 step in the Scheduler tracker after its plan completed | The Epic's PRDs in `session-manager-operations/scheduler/prds-archived/` (`scheduler_list_prds`, or `epicPrds` in the Epic detail) vs the plan band's `N steps · M done` header | Not data loss — `reconcile()`'s terminal-drop removes a finished step's `queue.json` row when `archiveCompletedPrd` moves its PRD. Bands must merge archived PRDs back in (`mergeArchivedPlanRows`); if the header total is below the archived count, that merge regressed. Guard: `trackerStepParity.test.tsx` |
| App died; next boot logs `likelyCause=compositor-disconnect`, exit 0, no dump | `electron-stderr.log` (app `logs/` dir, `~/.config/claude-code-session-manager/logs/` on Linux) tail contains `Fatal Wayland communication error`; `main-exit.jsonl` beside it | The compositor dropped a stalled Wayland client. The launcher now passes X11/XWayland on Electron's real argv on a Wayland session (`SM_OZONE_PLATFORM` overrides; `appendSwitch` does not work). If it recurs, check the `crash-diag` loop-stall lines for a blocked main loop. Watchdog relaunches are in `~/.claude/logs/scheduler-watchdog-relaunch.log` |
| App died; next boot logs `likelyCause=oom-scope-stop` / "killed by systemd" | `journalctl --user -u 'app-claude-code-session-manager-*.scope'` (scope `Result=oom-kill`), plus `last-run.json` and `main-exit.jsonl` in the app `logs/` dir | One child was OOM-killed and the default `OOMPolicy=stop` stopped the whole scope. Verify the drop-in `~/.config/systemd/user/app-claude-code-session-manager-.scope.d/10-oom-policy.conf` holds `OOMPolicy=continue` (`scopeOomPolicy.cjs` writes it at boot). Find the culprit job in the run logs |
| A job dies with SIGKILL / exit 137 at a constant memory size while the machine has free RAM | The job's `systemd-run --scope` unit: `MemoryMax`/`MemoryHigh` in `memoryScope.cjs`'s limits (45% of RAM, capped 10 GB; `SM_JOB_MEMORY_MAX_MB`), and the job's run log, whose `[scheduler] memory scope` line gives that job's peak memory and `oom_kill` count | The job hit its own cgroup limit, by design, instead of taking the machine down. Raise `SM_JOB_MEMORY_MAX_MB` only if the PRD truly needs it; otherwise split the work. Not an app crash |
| Every project shows paused (agent)/(manual) | `audit-log.jsonl` entries of `kind: scheduler_pause` — the `by` field names the calling session/cwd | Resume via the Scheduler Resume button or `scheduler_resume`. An agent pause auto-expires after 30 minutes and is cleared on app restart |
| `utilization-held` at 100% / `slots-exhausted` with 2 running while real usage is low | `~/.claude/session-manager-reboot.log` for `billing meter rate-limited (HTTP 429)`; `billing-cache.json` for the real percentages | Usage meter 429 treated as an account limit. PRD 1647 claimed the fix but it did not work until `meter-429-uses-cached-reading` landed; since then a meter 429 uses a ≤30-min-old cached reading with the full slot pool, and only an executor-observed `rate_limit` pause pins utilization. The remaining cases (transient meter failure, no cache, cache over 30 minutes old) run the degraded budget (cap 2) and tick with reason `usage-meter-degraded` |
| `lastTickReason` `utilization-held` or `manual-fire-policy`; nothing dispatches | Heartbeat `utilizationHold` (window, percent, threshold, resetsAt) and `usageMeter.appliedConcurrencyCap`; `billing-cache.json` for the real percentages; audit events `tool_confirmation_resume_held` / `job_continue_held` (also `investigation_held`, `resume_recovery_held`) for runs the hold deferred; heartbeat `heldSchedulerTurns` { count, tabs } plus audit `scheduler_turn_held` / `scheduler_turns_delivered` for scheduler chat turns it kept. The durable record of a hold is `audit-log.jsonl`: `auto_dispatch_hold_started` (reason, window, percent, threshold, resetsAt, holdKey, pending, version), `auto_dispatch_hold_ended` (adds startedAt, endedAt, maxPercent, heldTicks, `endedAcrossRestart` when it closed after a restart), `scheduler_human_press` (press `run-now`/`force-tick`, the hold in force or null) and `auto_dispatch_hold_bypassed` (the hold's fields plus `dispatched` slugs) | Intended: some live window is at/above "pause above", or the fire policy is manual. Wait for the named window's reset, raise "pause above", or press Run now (one human batch). Deferred runs start on their own once the hold clears |
| A `project_starve_escalated` alert (audit log, log line, toast) | Its `holdReason` field. The alert means the project had pending work and no dispatch for an hour; `holdReason` (`describeStarveHold`, `starvation.cjs`) names the limiter | `dependency-blocked`: every pending row waits on a `dependsOn` that is not complete — fix the blocker (see the `dependsOn` row above). `launch-blocked`: every pending row's launch persona has an open circuit breaker (§6) — Resume/Run now or wait out the backoff. `dispatching-elsewhere`: the last tick fired for other work and nothing else limits this project — it is queued behind it; wait. Machine-wide reasons are the last tick's own reason: `memory-deferred`, `slots-exhausted`, `usage-meter-degraded`, `load-deferred`, `held` — see the matching rows. `unknown` means the scheduler had not ticked yet since boot; force a tick (open the Scheduler view or restart) |
| `rate_limit` pause to the weekly reset while `billing-cache.json` shows usage well below threshold | The run log for a `rate_limit_event` with `status "rejected"` — none means the pause was spurious | Pre-fix substring detection treated `allowed` events as rejections (2026-10-11, 4-day pause at 58% weekly). Resume via the Scheduler Resume button or `scheduler_resume` |
| A row stays `running` for hours, its `runtime.pid` is not a claude process or is shared by two rows | `/proc/<pid>/cmdline` argv[0], and the audit-log `job_pid_recovered_by_liveness_scan` event for that slug | `scheduler_cancel_job` then `scheduler_reset_job`. Since the fix, liveness requires a claude argv[0] and a run log, and a pid is never adopted twice |
| A process from a finished job is still running | `SM_SCHEDULER_JOB_SLUG` in `/proc/<pid>/environ` names the finished job's slug; `job_leftovers_stopped` entries in `audit-log.jsonl` show what the stops already caught | Three layers stop it (`jobLeftovers.cjs`): the process-group sweep at job exit, the job scope stop on systemd, and the 5-minute leftover sweep on Linux. macOS has only the group sweep. A survivor means a layer did not run (app older than the fix, no systemd) — kill it by hand; a PRD that needs a daemon must use a service manager, not `nohup` or `&`. The one detached process a job starts on purpose is the demo-video kit's speak runner (`character.cjs speak` → `resumableRun.cjs`): on Linux the job scope stop and the leftover sweep end it with the job, and everywhere its 20-minute caller lease ends it once no call checks in |
| `lastTickReason` `load-deferred`; detail reads `CPU load gate: loadavg1 … = ratio > threshold, CPU N% busy over Ms (or no CPU sample yet), held Nm with slots and memory free` | The detail's CPU figure is the ~1-minute sample (`cpuBusy`); under 50% busy the gate stands down, `no CPU sample yet` means loadavg decided (and yields at the limit). `held Nm with slots and memory free` counts only time THIS gate held a batch that slots and memory admitted (each gated tick credits at most 2 min), not wall-clock since the last launch. Audit kinds in `audit-log.jsonl`: `launch_load_gated` (held, rate-limited to one per 10 min), `load_gate_stood_down` (loadavg high, CPU sample mostly idle, launch allowed), `load_gate_yielded` (45-min limit at 50-85% busy or no sample, one job let through), `load_gate_escalated` (85%+ busy: no launch, repeats every 45 min with a toast), `load_gate_last_resort` (starvation watchdog bypass on a saturated CPU: one job launched; a human Run now bypasses with the full batch) | **Automatic** — releases when loadavg falls or the sample shows under half busy; at 50-85% busy (or no sample) the 45-min limit yields one job; at 85%+ it keeps holding and escalates until load drops. Size a hold by counting heartbeats per `lastTickReason` (see §3), not from the detail's minutes |
| Every project pending, nothing dispatching, `lastTickReason` `held` | Heartbeat `dispatch.lastTickDetail` (quiet-machine lease, untracked running rows, `dependsOn` hold) | A quiet-machine lease releases when its job ends; it is meant only for timing-measurement PRDs |
| All projects held, 0-1 running, many pending, for long | Heartbeat `dispatch.quietLeaseHolder` names the slug; or `grep -l '^quietMachine: *true'` over the Epics' `prds/*.md` | If that PRD has no timing criteria: `scheduler_cancel_job`, `scheduler_update_prd {quietMachine:false}`, `scheduler_reset_job`; dispatch resumes in ~25 s |
| Epic got no PLAN SETTLED digest | Whether the app restarted inside the settle window (`SM_EPIC_SETTLE_SECONDS`, default 120) after the Epic's last terminal check-in; the timer is in memory | The next terminal check-in re-arms it. Also check `SM_EPIC_VALIDATION_DISABLE` is not set |
| Auditing a claim that a run's work was lost / "completed" without landing | `<slug>.outcome.json` (final verdict, incl. spawn-level overrides), not `<slug>.verdicts.json` (verifyRun only); commit evidence is the job worktree's HEAD reflog (`git commit -q` leaves no transcript event), readable only before teardown | Audit on outcome.json; for older losses `git fsck --no-reflogs --unreachable` crossed with the run window, confirmed by subject on the base branch (windows overlap siblings) |
| PRD skipped `prd-missing` (exit 0) while its file exists | Whether the project fell out of `allProjectCwds` at the skip time: its newest transcript's tail had no `cwd` line (huge lines) | Simulate the tail scan over that jsonl before persona/path theories. `activeSessions.cjs` now grows the tail (to 1 MB) and tries 5 newest files, and the retire re-checks first; `scheduler_reset_job` `force:true` re-runs it |
| Need to restart the live app without killing jobs | — | From the repo: `node -e "require('./src/main/lib/scheduler/upgradeDrain.cjs').requestRestart({reason:'…',requestedBy:'user'})"` writes `restart-request.json`; the heartbeat drains dispatch, waits for running jobs, relaunches via npx (same as UI Reboot, no force); it ends the calling chat |
| `pass_no_commit*` row healed `completed` via `ladderRung: reverify` | `committedInWindow(cwd, startedAt, finishedAt)` counts ANY commit in the window, including another job's | `git log --since/--until` over the run window; if the commit is foreign, the verifier gap is real — don't trust the heal |
| A bug reproduces that looks fixed at HEAD, or an MCP/admin-API "contract mismatch" | The live app is the npx build, not HEAD: its `node_modules/claude-code-session-manager/package.json` version vs `npm view claude-code-session-manager version`, heartbeat `build.version` at the call time; for a logged error, `git log -S"<message fragment>"` vs its emit time | Restart onto current code (drain first) instead of filing a fix. The `session-manager-scheduler` MCP server runs from the checkout, so tool text tracks HEAD while the API is the installed build |
| `needs_review` `reaped_without_integration` after an app crash/restart; boot sweep deleted `sm-job/<slug>` | The commit survives at `refs/sm-stranded/<slug>/<sha>` (`git for-each-ref refs/sm-stranded`) | Fast-forward the main checkout to it when its parent is main's tip, then `scheduler_archive_prd` (with cwd) to complete the PRD and free dependents |
| Validator budget or sweep split sized too small for its gates | Whether the code summed gate time through `resolveGate` — it returns an empty sequence for a shell-syntax gate | Never sum gate time through `resolveGate`; `gateTimeoutMs` (`definitionOfDone.cjs`) reads the raw chains for that reason |

### Usage threshold vs rate_limit pause

- `config.utilizationThreshold` (default 90, editable 0-100 via "pause above" on the Scheduler band; 95 is allowed) sets the `utilization-held` hold (`scheduler/utilizationHold.cjs`, `evaluateAutoDispatchHold`). `tickQueue` (`tickBody`'s hold step) applies it to **every automatic tick**: job finish, the dispatch loop, a freed slot, the reaper, an investigation exit, the billing poll (`maybeLaunchWhenAvailable`), the starvation watchdog (`runQueueStarvationWatchdog`, which also skips its starvation warning and forced tick under the hold), and boot/resume `runDueJobs`. It is not a flat cap: "pause above" applies only with the whole window left; the cap then rises linearly to 99% when 2/7 of the window is left (2 days of a week, about 1.4 h of the five-hour window) and stays 99% until the reset. Why 99, not 100: the last 1% is kept for interactive chats so they keep working until the reset (the owner's choice, 2026-11-24); a saved "pause above" of 99 or more is returned unchanged, so a saved 100 still means 100. To let automatic work reach the limit again, set `PRO_RATE_CEILING` back to 100. `proRatedThreshold` (`scheduler/utilizationHold.cjs`) computes it per window; the hold records the cap in force as `threshold` and the saved "pause above" as `baseThreshold`. The same function is applied by `health.cjs` (so a dispatching queue is not called held), by the `rate_limit` auto-resume (`bindingWindowPauseThreshold` in `scheduler.cjs`), and by the snapshot's `effectiveUtilizationThreshold`, shown on the band as a 'now N%' hint beside "pause above" when the two differ. Why: the owner would rather spend the credits than stop short of the limit. Revert to a flat cap: set `PRO_RATE_CEILING` (99) to 0, since a "pause above" at or above it is returned unchanged; `PRO_RATE_FULL_FRACTION` (2/7) moves the point where the cap reaches 99%. To pause only near 95% weekly, set it to 95.
- Every path that starts a `claude -p` run, with its rule:
  - Automatic ticks (`tickBody`) hold and record `lastTickReason` `utilization-held` (or `manual-fire-policy`).
  - Auto-fix investigations (`spawnInvestigation`, audit `investigation_held`) and resume-recovery runs (`spawnResumeRecovery`, audit `resume_recovery_held`) wait. They stamp nothing on the row, so their periodic pass (auto-fix targets, `reverifyNeedsReview`) starts them once the hold clears.
  - An approved tool confirmation (`processToolConfirmationAnswers`) stays pending (audit `tool_confirmation_resume_held`, once per record per hold); a later tick applies it once the hold clears. A denial starts nothing and still parks the job at once.
  - `continueJob` (`POST /admin/scheduler/continue-job`) is refused with the hold detail for every caller (audit `job_continue_held`): its only caller is the loopback admin route, which cannot prove a human. The row stays interrupted, so the same call succeeds once the hold clears.
  - `POST /admin/tasks` (`tasks/taskAdminRoutes.cjs`) reads `currentUsageHold()` (`scheduler.cjs`) after `409 session_busy` and before the ledger start line: a hold answers `429 usage_held` (a failed read `503 usage_hold_error`), audit `task_usage_held` once per project per hold. It reads the hold again once the slot is granted: a hold then releases the slot, writes the end status `usage_held` and answers `429 usage_held` with `taskId` and `slotWaitMs`; a failed read there also releases the slot and writes the end status `usage_held`, but answers `503 usage_hold_error` (`details`, `taskId`, `slotWaitMs`), never `429`. A Task that waited through the hold never spawns.
  - No body key, `priority` or `caller` bypasses the Task hold: the route is loopback-only and cannot prove a human.
  - `firePolicy: 'manual'` does not apply to Tasks: `currentUsageHold` passes `firePolicy: null`, because firePolicy is the PRD queue's own setting; only the utilization rule at the same "pause above" threshold (`usageHoldThreshold()`) holds a Task.
  - The Task timers `maybeStartConsolidation` (`tasks/memoryConsolidation.cjs`) and `maybeStartMitigationReview` (`tasks/mitigationReview.cjs`) read `currentUsageHold` first and return `reason: 'usage_held'`: they start no Task and record no cadence (mitigationReview writes no new model state). One list, `NOT_RUN_STATUSES` (`tasks/memoryConsolidation.cjs`), decides what is not a run: `usage_held`, `usage_hold_error`, `slot_timeout` and `too_many_waiting`. memoryConsolidation does not count a Task with one of those statuses as a run, and mitigationReview puts its previous model state back when its review Task is answered with one of them, so they try again on their next pass.
  - `GET /admin/usage-hold` (`scheduler/usageHoldRoute.cjs`) and the MCP tool `usage_hold_get` read the same `currentUsageHold` answer, so a runner that starts `claude -p` directly can honor the same hold.
  - Scheduler-started chat turns (`origin: 'scheduler'`: the PLAN SETTLED digest, the `notifyOriginatingTab` fallback notice, the auto-start follow-up) are held at `chatRunner.enqueueExternalPrompt` (`holdSchedulerTurn`) and kept in `held-scheduler-turns.json` (`lib/scheduler/heldSchedulerTurns.cjs`), audit `scheduler_turn_held` once per tab per hold. Once the hold clears, `drainHeldSchedulerTurns` (`scheduler.cjs`) delivers each tab's held messages as one coalesced turn (audit `scheduler_turns_delivered`; an auto-start follow-up whose session no longer needs a plan is dropped). Decided exceptions: an inbound-proposal turn (`origin: 'inbound-proposal'`) auto-started by a verified human quote or macro grant still runs, because a human granted it; admin-api (`POST` prompt relay) and `feedback_reply` sends are not held, because the live turn that makes them is already gated.
  - Only a human **Run now** or **Fire next batch now** (`runDueJobs({ human: true })`) bypasses the hold.
  - A hold's evidence lives in `~/.claude/session-manager/audit-log.jsonl` (the four hold kinds in §7's `utilization-held` row); job starts are `job_transition` events whose `to` is `running` or `investigating` (sources `spawnJob:dispatch`, `spawnInvestigation:start`). The log rotates to `audit-log-YYYY-MM.jsonl.gz` monthly or past 32 MB, six files kept (`auditLogMonths`).
  - `scheduler-heartbeat.log` keeps only two 1 MiB files (live + `.1`, about 18-37 hours at one line a minute), shorter than a weekly hold, so a check on a longer hold reads the audit log, not heartbeats.
- `firePolicy: 'manual'` holds every automatic path the same way, with reason `manual-fire-policy`.
- The hold reads **every unscoped window of the last real reading** (`utilizationReading().windows`, from `usageWindows` in `lib/claude/usageCircuit.cjs`), not only the highest one; with no usable unscoped `limits[]` entry it reads the flat `five_hour` and `seven_day`. A window whose reset has passed is skipped, so the hold lifts only when no live window is at or above the threshold, and it names the holding window that resets last (heartbeat `utilizationHold`: window, percent, threshold, resetsAt).
- With no real reading ever (`known: false`, the 100% placeholder) there is no hold; the degraded cap of 2 (`usageMeter.appliedConcurrencyCap`) bounds dispatch instead.
- During a meter outage the hold uses the last real reading (the last good payload), and across a restart the window list restored from `scheduler-state.json`.
- It never sets a pause. A `paused.reason: rate_limit` comes only from an executor-observed rejection and resumes at the rejected window's reset, or after 30 minutes when billing shows every window below the threshold.

### Plan bands read live rows PLUS archived PRDs

A finished step's row leaves `queue.json` (`archiveCompletedPrd` + `reconcile()`'s `if (!p)` terminal-drop), so live rows alone shrink a completed plan to its live remainder. Plan bands therefore build from live rows merged with the Epic's archived PRDs (`lib/archivedPlanRows.ts`), the same history `epicDerive.ts`'s `epicPrds` always showed. One Epic may hold several plans (waves), keyed by the stamped `planId` (connected-component derivation is the fallback for PRDs without one): a follow-up that `dependsOn` an earlier step appends to that plan; an independent one opens a new plan. The band header states `N steps · M done` from the plan's own rows, so a shrinking band is never mistaken for a lost plan.

## 8. What recovers automatically vs what needs a human

**The human-facing notice is quiet and grouped, not immediate** A park into
`needs_review` records a notice on the job row (`reviewNotice.cjs`'s
`buildReviewNotice`) and sends nothing yet — the ladder above almost always
heals it first. A human reset (`resetJobFields`) deletes that notice outright,
so a re-park afterward starts a fresh hold clock; a rung-6 ladder requeue does
not reset it, so the clock survives one more lap — it is still the same
unresolved episode. The authoring Epic gets exactly ONE message per (project,
Epic, cause) group, sent only when the ladder gives up on a row (an
auto-resolve skip, rung 6) or the row has sat `needs_review` with no
resolution for `SM_REVIEW_NOTICE_HOLD_MINUTES` (default 240 minutes) — a
not-yet-due row only joins that group once it has sat for at least 30 minutes
itself (`SWEEP_MIN_AGE_MINUTES`), so the ladder's early rungs get a fair
chance first. `scheduler.cjs`'s `flushDueReviewNotices` is the sole sender; it
groups every row sharing the same cause into one plain-language message that carries, per PRD,
its title, goal line, the reason it stopped and an `Answer needed:` line (so the Epic can answer
without opening the Scheduler), delivers it to the authoring Epic whatever that Epic's status
(`allowInactive`),
names any pending PRD the group still blocks via `dependsOn` instead of
always claiming nothing is waiting, and retries a send that errors up to 3
times, then stamps it sent anyway so a dead Epic cannot loop forever.

**Automatic, no operator action required:** the starvation watchdog forcing a tick (§3); rungs
1, 2, 4, 5, and the bounded part of rung 6 of the needs_review ladder (§4); the reap/orphan
git-evidence gate promoting a wrongly-reaped row to `completed` (§5); the launch circuit breaker
re-probing on backoff and self-clearing on a CLI version change (§6); torn `scheduler-machine.json`
prefix recovery (§7); a leaked worktree-cap counter self-correcting against observed disk state
(§7); failed → pending auto-reset (up to 3 attempts over 10-minute windows); a `failed` row that exhausted its 3 auto-resets and sat past `STUCK_FAILED_ESCALATE_MS` (24h) being auto-skipped (`applyStuckFailedAutoSkip`) with a grouped review notice so dependents drain; scheduler-sent Epic turns never ask questions (`SCHEDULER_TURN_INSTRUCTION`, `chatRunner.cjs`); a stranded
`investigating` row being restored to its prior terminal status after 1 hour with no live probe.

**Genuinely requires a human (usually):** a `'blocked'` (not `'starved'`) verdict from §3 — every
pending row is behind a terminal/parked dependency and no automatic pass can resolve that; rung 3
(quarantine) never resolves a row by itself, only clears the shared tree so a later merge can
succeed — the row needs a real fix; a `verifierVerdict: 'budget_exceeded'` park (§7) — it is
excluded from ladder rungs 1-4 by design, so it sits until rung 5/6 finds `looksDone` evidence or
a human intervenes (except a budget-killed validator, which arms the settle and needs no human); a launch breaker that has exhausted
`LAUNCH_BLOCK_MAX_ATTEMPTS` (8) with no CLI version change; a quarantined row nobody has adopted past `QUARANTINE_ESCALATE_MS` (24h
default) — quarantine promotion out of `quarantined` only ever happens through the adopt path,
never a timer; a `worktree_integration_failed` verdict where the branch itself no longer exists
(mechanical recovery's one retry already failed).

## 9. Stuck-row triage

Runbook for "is this specific row actually done, despite what `queue.json` says?" — a
narrower, different incident than the dispatch/recovery machinery above. Written after PRD
`926-epic-prds-tab-include-archived` sat at `status: "running"` for nearly an hour after its
`claude -p` process had already exited cleanly, its code review passed, and its commit had
already landed on `main`: the scheduler's completion handler can fail partway through — run
artifacts get written, but the `status: "completed"` transition doesn't — leaving the row
stuck at `"running"` until the app restarts (a live app with a desynced row doesn't
self-heal). Tracked as Epic `scheduler-job-status-desyncs-from-run-completion-95fcbba3`.

**Ground truth for "did this job actually finish?" is the run's artifact directory, not the
queue row**:

```
~/.claude/session-manager/scheduled-plans/runs/<runId>/<slug>.meta.json      # exitCode, finishedAt, worktreeSetup
~/.claude/session-manager/scheduled-plans/runs/<runId>/<slug>.verdicts.json  # review verdict
~/.claude/session-manager/scheduled-plans/runs/<runId>/<slug>.log           # full stream-json transcript
```

`runId` is the job's `runId` field in `queue.json` (also the run folder's timestamp). If
`<slug>.meta.json` exists with a non-null `exitCode`, the process is done — regardless of
what `queue.json.status` says.

**Fast triage checklist:**

1. `queue.json` → find jobs with `status: "running"`. Note `runtime.pid` and `runId`.
2. `ps -p <runtime.pid>` — is the process actually alive?
   - **Dead PID + desynced status** → completion handler didn't finish its write. Check
     the run's `.meta.json` for the real outcome (see above) before touching anything.
   - **Alive PID** → genuinely in-flight. Check `ps -o etime` against the PRD's
     `estimateMinutes` — significantly over estimate is worth a look at the live log
     tail, but is not automatically "stuck" (long PRDs happen; see §7's budget-watchdog row).
3. Cross-check with the admin API (works even without shell access to the box):
   `scheduler_list_jobs` (MCP tool, wraps the loopback admin server) mirrors `queue.json` —
   same caveat applies, it is not more authoritative than the file.

**What NOT to do:**

- **Do not call `scheduler_reset_job` on a row whose run artifacts show a clean exit.**
  Reset re-queues the PRD as `pending` and re-runs it from scratch — for an already-shipped,
  already-committed PRD this duplicates real work (cost + wall-clock) and can produce a
  conflicting second commit on top of the first. Reset is for genuinely hung or crashed jobs
  only, confirmed via the PID-liveness check above.
- **Do not hand-edit `session-manager-operations/scheduler/state/queue.json` outside the app's write path.** It's an
  OWNERS namespace (`scheduler` is the sole writer, per `opsOwnership.cjs`) — external edits
  race the live app and can corrupt the file the next time it writes. If a row needs
  correcting, that's a `scheduler.cjs` code fix (make the completion handler's two writes
  atomic, or add a reconciliation pass), not a manual patch.

## 10. Concurrent-writer hazard — the repo is never idle

Multiple scheduler jobs (and the `builder` agent) can run against the same working tree at
once. Never assume a diagnosis/fix session has the repo to itself, and never treat `git
status` from ten minutes ago as still accurate — re-run it immediately before staging or
committing anything. A file growing beyond your own diff, a version bump you didn't make, or
scheduler/Epic state changing underneath you are signs of a live sibling writer, not repo
corruption; diff each file and separate your own change from the concurrent one rather than
blindly `git add -A`-ing both together. (Incident, 2026-08-02: a perf-fix session's own
4-file diff coexisted with an unrelated concurrent rewrite of `chat.ts` and a mid-session
`package.json` version bump neither of which it made, per that session's now-retired
resume note.)

## 11. Job sandbox

Every headless PRD job is confined by
[`jobSandboxPolicy.cjs`](../../src/main/lib/claude/jobSandboxPolicy.cjs). `executeJob` in
`scheduler.cjs` calls `buildJobSandboxSettings({ agentType, worktreeDir, projectRoot, homeDir,
tmpDir, deps: resolveJobSandboxDeps() })` and passes its `argv` to `buildClaudeSpawnArgs` as
`sandboxArgs`, which replaces the old single `--dangerously-skip-permissions` flag. The
investigation spawn (`spawnInvestigation`) calls it too, with `agentType: 'investigation'` (always `tool-rules`).

### Coverage — every headless `claude` spawn

- **PRD jobs** (`executeJob`, `scheduler.cjs`): `os-sandbox` for `validator` and `dev-lead` when
  the OS sandbox dependencies are present, else `tool-rules`; every other persona `tool-rules`.
- **Investigation probe** (`spawnInvestigation`, `scheduler.cjs`): `tool-rules` (`agentType: 'investigation'`).
- **Tasks** (`buildTaskArgs`, `lib/tasks/taskRun.cjs`): `tool-rules` when the Task skips
  permissions (`dangerouslySkipPermissions: true`, `agentType: 'task'`); without that flag no
  policy is added and the CLI's own permission prompts apply.
- **`runClaudeP`** (`lib/claude/runClaudeP.cjs`), **`docEdit.cjs`** and **`supervisor.cjs`**
  (`runProbe`): `tool-rules` (`agentType: 'aux'`, dependencies passed as unavailable, rooted at
  `process.cwd()`).
- **Interactive Epic chats**: not covered — out of scope for this policy.

`tool-rules` blocks the `Read`, `Write` and `Edit` tools and a plain Bash `cat` of a secret, but
not an interpreter such as `python3 -c 'open(...)'` (or `sh -c 'cat $1'`). Only `os-sandbox`
contains Bash.

### Two levels

| Level | Who gets it | What it passes |
| --- | --- | --- |
| `os-sandbox` | `validator` and `dev-lead` (the keys of `LEGACY_PERSONA_ENVIRONMENTS`, mapped onto environment profiles), or a persona that declares an `environment:`, **only** when the OS sandbox dependencies are present | No `--dangerously-skip-permissions`. `--permission-mode <profile mode>` plus `--settings` that turn on the CLI sandbox (`enabled`, `failIfUnavailable`, `allowUnsandboxedCommands: false`, `autoAllowBashIfSandboxed`), allow `Read(//**)`, `Glob`, `Grep`, `Bash`, `Skill`, `Agent`, `ToolSearch`, `TodoWrite`, and deny the secret paths plus `WebFetch` and `WebSearch`. |
| `tool-rules` | Every other persona, and `validator`/`dev-lead` when the dependencies are missing or disabled | Keeps `--dangerously-skip-permissions`, plus `--settings` with `permissions.deny` `Read`/`Edit` rules over the secret paths. This is a guard against plain tool use, not containment. |

Dependencies (`sandboxDependencies`): Linux needs `bwrap` and `socat` on `PATH`; macOS needs
`sandbox-exec`; any other platform is unsupported. On Linux `resolveJobSandboxDeps` also runs a
`bwrap` self-test (`--unshare-net --unshare-pid -- true`); a failure degrades to `tool-rules`
with reason `bwrap self-test failed`. The result is computed once per process and never throws.

### Secret paths

Relative to the home directory (`SANDBOX_SECRET_PATHS`). At both levels each gets
`Read`/`Edit` deny rules on the path and `/**` under it; at `os-sandbox` each is also in
`sandbox.filesystem.denyRead` and in `sandbox.credentials.files` with mode `deny`.

`.npmrc`, `.netrc`, `.ssh`, `.gnupg`, `Self/secrets`, `.claude/.credentials.json`, `.config/gh`,
`.google_workspace_mcp`, `.config/google-workspace-mcp`, `.aws`, `.docker/config.json`.

Rule paths use a leading `//` for an absolute path (a single `/` would be relative to the
settings file).

### Profiles — write roots and network

Both `os-sandbox` profiles share the same write roots (`sandbox.filesystem.allowWrite`):

- the job worktree (`worktreeDir`);
- `<projectRoot>/.git` — a job worktree commits into the main checkout's `.git` (objects, refs,
  `worktrees/<name>`); the CLI keeps `.git/hooks` and `.git/config` read-only itself;
- the job's private temp dir (`tmpDir`): `fs.mkdtempSync` makes `/tmp/smj-XXXXXX` (directly under
  `os.tmpdir()`, kept short because the CLI's proxy sockets live there and socket paths cap at
  108 bytes); `sandboxChildEnv` points `TMPDIR`, `TMP` and `TEMP` at it, and it is removed when
  the job ends. If it cannot be made the job falls back to `os.tmpdir()`. No other `/tmp` dir is
  writable;
- `~/.npm` and `~/.cache`;
- `<projectRoot>/node_modules/.vite` and `<projectRoot>/node_modules/.vitest`.

| Profile | `--permission-mode` | Bash network allowlist (`strictAllowlist: true`) |
| --- | --- | --- |
| `validator` | `default` | none (empty list) |
| `dev-lead` | `acceptEdits` | `registry.npmjs.org`, `api.github.com` |

`dev-lead` is the builtin `headless-default` environment. `api.github.com` is allowed so release
live checks can read public GitHub releases; jobs hold no credentials, so this is unauthenticated
read-only access, like the `registry.npmjs.org` entry that serves `npm view`.

A `tool-rules` job has no write or network restriction beyond the secret deny rules.

### Personas today and next stage

One row per file in `src/seed/agents/`. Next-stage allowance is read from the persona's `tools:`
line (`WebFetch`/`WebSearch` = web; a release persona = npm registry; else none);
`validator` and `dev-lead` keep their current profile.

| Persona | Level today | Next-stage network |
| --- | --- | --- |
| `architect` | `tool-rules` | none |
| `blender-artist` | `tool-rules` | none |
| `competitive-analyst` | `tool-rules` | web |
| `competitive-researcher` | `tool-rules` | web |
| `demo-video-builder` | `tool-rules` | none |
| `dev-lead` | `os-sandbox` when available | npm registry + api.github.com (already live) |
| `project-home-builder` | `tool-rules` | none |
| `validator` | `os-sandbox` when available | none (already live) |

An `os-sandbox` profile for `demo-video-builder` must let the kit's speak runner outlive one Bash
call: it is detached on purpose so a slow voice can span several calls (exit 75 = call again), and
`bwrap --unshare-pid` would kill it when each call ends.

### Switch and run meta

- `SM_JOB_SANDBOX=0` in the app's environment makes `resolveJobSandboxDeps` report
  `missing: ['disabled by SM_JOB_SANDBOX=0']`, so every job runs at `tool-rules` (the secret
  deny rules stay).
- Every run that reaches the spawn step writes run meta JSON with a `sandbox` key —
  `{ level, profile, network, reason, tmpDir }`. The two meta writes before the policy resolves
  (finish-protocol composition failed, prompt failed validation) omit it. `network` is `null` at
  `tool-rules`; `reason` says why a job fell back, e.g. `no sandbox profile for persona architect`
  or `OS sandbox unavailable, missing: socat`; `tmpDir` is the private temp dir, or `null` when
  none was made (every `tool-rules` job). The scheduler log has the same line:
  `[scheduler] sandbox: level=… profile=… network=… reason=… tmp=…`.

### Probe

`npm run probe:job-sandbox` (`scripts/job-sandbox-probe.cjs`) is a manual developer probe, not
part of any gate. For each profile it runs one short `claude -p --model haiku` with the real
policy argv against a throwaway fake home holding canary secrets, asks it to read the secrets,
write outside its worktree and fetch an off-allowlist domain, and reports every escape. Exit 0 =
contained, 1 = an escape or a failed positive control (the inside write), 2 = SKIP (dependencies
missing). Each profile gets a private `/tmp/smj-*` tmpDir and the `sandboxChildEnv` env, as in
the scheduler, plus outside targets under `$HOME` and in a sibling `/tmp` dir.
`node scripts/job-sandbox-probe.cjs --dry-run` prints `{ deps, profiles }` and spawns nothing.

`--fetch-socat` (Linux, `socat` missing) runs `apt-get download socat` and `dpkg-deb -x` into
fresh temp dirs and puts that `usr/bin` on `PATH` for this probe run only — no install, no sudo,
both dirs removed afterwards. It is for proof only: real jobs in the app still need
`sudo apt install socat` to run at `os-sandbox`.

Result of `node scripts/job-sandbox-probe.cjs --fetch-socat` on 2026-11-22 (HEAD `691a5ed5`,
CLI 2.1.325), exit 0:

```
profile	level	escapes	controlsFailed	run
validator	os-sandbox	none	none	exit 0
dev-lead	os-sandbox	none	none	exit 0
PASS: no escapes, controls ok
```

### Evidence (CLI 2.1.325, 2026-11-22, canary files)

- `permissions.deny` rules passed with `--settings` held under `--dangerously-skip-permissions`
  for the Read and Write tools and for plain Bash `cat` or redirect, with a reported error.
- `python3 -c "open(...)"` and `sh -c 'cat $1'` bypassed those same rules.
- `--permission-mode acceptEdits` plus `--permission-prompts none` confined the Read and Write
  tools to the cwd and `--add-dir`, but not Bash.
- `sandbox.enabled` with `failIfUnavailable` refused to start without `socat`.
- Live check on 2026-11-22 with a temporary `socat` 1.8.0.0: both profiles ran at `os-sandbox`;
  canary reads by the Read tool, `cat` and `python3` were refused; `curl` to `example.com` was
  blocked; Write tool and Bash writes outside the worktree under `$HOME` were refused with
  `Read-only file system`. It found one hole — Bash could write anywhere in `/tmp` — closed by
  PRD `job-sandbox-private-tmp` (the private temp dir above).

### Loopback reach

Probe on 2026-11-24 (CLI 2.1.330, real policy argv, unpacked `socat`) against a server on the
host's `127.0.0.1`. The decision it led to is the
[Loopback bullet](managed-agents-alignment.md#environments).

- Sandboxed Bash runs in its own network namespace.
- The CLI sets `NO_PROXY=localhost,127.0.0.1,::1,…` in the job's environment.
- Direct `curl` and node `fetch` to the host `127.0.0.1` server were refused.
- Forced through the proxy (against `NO_PROXY`): `403` with `allowedDomains` `[]`, `200` with
  `allowedDomains` `[localhost, 127.0.0.1]`.
- `allowLocalBinding` had no effect on either result.

### Dispatch-time live checks

- The scheduler runs each judged PRD's http and file criteria once per validator run, just before the validator starts and outside its sandbox (`runDispatchCriteriaChecks` in `scheduler.cjs`). Checks run one after another; each http attempt is capped at `HTTP_TIMEOUT_MS` (15 s).
- A failed http check whose request was sent (connection error, timeout, wrong status, `contains` miss) is retried: up to `HTTP_RETRY_ATTEMPTS` (3) attempts in all, `HTTP_RETRY_DELAY_MS` (10 s) apart. The waits are shared by all criteria of one judged PRD, not taken per check.
- Never retried: spec refusals (bad URL, non-loopback host, credentials) and file, command and manual checks. The gate-shadow and job-row checks stay single-shot.
- Why: a local dev server is often mid-reload in the seconds after a landing. A FAIL after 3 attempts is a real FAIL, not a reload blip.
- Worst case per judged PRD: 3 attempts of up to 15 s per http criterion, plus 2 waits of 10 s. A stopped service refuses at once, so it costs about 20 s.
- Each fresh row stores `attempts`, `ranAt`, `stage: validator-dispatch` and `bodyPath` (the body sits in a sidecar file).
- The verdict is cross-checked against those same results. The dispatch-time expected map is stamped on the queue row as `validatorCriteriaExpected`; `notifyOriginatingTab` never re-runs the checks.

### Residual risks

- **The CLI sandbox wraps Bash only.** Hooks and MCP servers run outside it; in-process tools
  are governed by the permission rules, not the OS sandbox.
- **Tool rules are bypassed by interpreters without the OS layer.** At `tool-rules` a job can
  read a secret with `python3`, `node` or `sh -c`.
- **The `.git` common dir is writable** so a job can commit; a job can therefore rewrite refs and
  objects of the main checkout.
- **WebFetch is not gated by the sandbox network allowlist** — the allowlist covers Bash only.
  `os-sandbox` denies `WebFetch`/`WebSearch` outright; at `tool-rules` they are unrestricted.
- **No nested user namespaces inside sandboxed Bash** — Chromium/Electron's own sandbox (and so
  Playwright e2e) cannot start there.
- **`socat` is required on Linux.** In report mode a missing `socat` drops `validator` and
  `dev-lead` to `tool-rules`; in enforce mode it refuses those jobs (`environment_unavailable`)
  and does not downgrade them.

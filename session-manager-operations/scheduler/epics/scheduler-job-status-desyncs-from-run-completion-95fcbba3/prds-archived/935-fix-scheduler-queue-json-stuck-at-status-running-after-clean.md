---
title: Fix scheduler queue.json stuck at status:running after clean job exit (reapDeadRunningJobs runningSet desync)
cwd: /home/bilko/Projects/session-manager
estimateMinutes: 20
sourcePromptId: scheduler-job-status-desyncs-from-run-completion-95fcbba3
---
# Goal

Fix a confirmed root cause in src/main/scheduler.cjs where a job's run artifacts (meta.json, verdicts.json) can be written to disk with a terminal exit code, and the child process can be fully dead, while queue.json's job record is left stuck at status:"running" forever, with no self-healing until an app restart.

Root cause (already diagnosed, do not re-derive): `spawnJob()` (scheduler.cjs) wraps its entire body — including the completion `mutate()` call that flips a job's queue.json record from `status:"running"` to `status:"completed"`/`"failed"` — in one `try { ... } catch (e) { console.error(...); } finally { runningSet.delete(job.slug); ... }` (the catch is around scheduler.cjs:3016-3018, the finally at 3018-3024). If ANY exception fires between `executeJob()` resolving (which happens only after meta.json is already written synchronously to disk — scheduler.cjs:2231-2236 — so the process really has exited and artifacts really do exist) and the completion `mutate()` finishing (e.g. `writeQueue` explicitly throws at scheduler.cjs:918-920 on an unreadable read, or any of the git/history calls in between throw), the exception is swallowed by the catch and NEVER reaches the `mutate()` that would set `status:"completed"`. Critically, the `finally` block still runs unconditionally and calls `runningSet.delete(job.slug)` (scheduler.cjs:3019) — removing the slug from the in-memory `runningSet` regardless of whether the queue.json status flip actually happened.

This breaks the *only* existing periodic reconciliation pass, `reapDeadRunningJobs()` (scheduler.cjs:3197-3235), which is invoked every ~60s from `pollLoop()` (scheduler.cjs:3253). Its very first line is a fast-path bail: `if (runningSet.size === 0) return;` (scheduler.cjs:3199). Because the crashed job's slug was already scrubbed from `runningSet` by the `finally` block above, this fast-path check can be true (or simply never include that slug) even though `queue.json` still has a row with `status:"running"` for it — so `reapDeadRunningJobs` returns immediately without ever reading `queue.json` to check for exactly this condition. The job is now permanently invisible to the only self-healing mechanism that exists, and stays `status:"running"` until the Electron app restarts (which triggers the separate boot-orphan reconciliation in `init()` — `partitionBootOrphans`/`applyOrphanOutcome`, scheduler.cjs ~4094-4149 — a DIFFERENT code path that only runs at boot).

Live repro proving this is real, currently on this repo's own queue.json (DO NOT touch or edit this job's record as part of the fix — it must self-heal from the fix alone, verify that it does but don't hand-edit it): slug `926-epic-prds-tab-include-archived`, `runId: "2026-08-02T04-44-13-742Z"`, `runtime.pid: 1469438` (confirmed dead via `ps -p 1469438`), `status: "running"`, `finishedAt: null` in `session-manager-operations/scheduler/state/queue.json` — while `~/.claude/session-manager/scheduled-plans/runs/2026-08-02T04-44-13-742Z/926-epic-prds-tab-include-archived.meta.json` and `.verdicts.json` both exist on disk with a clean/terminal outcome.

Fix `reapDeadRunningJobs()` so its reconciliation is driven by `queue.json`'s actual job records (the source of truth), not by the `runningSet` in-memory cache, which this incident proves can desync from it. The `runningSet.size === 0` line must not be able to cause a job that is genuinely `status:"running"` in `queue.json` with a dead pid to be silently skipped forever.

# Acceptance criteria

- [ ] In src/main/scheduler.cjs, reapDeadRunningJobs() (currently scheduler.cjs:3197-3235) no longer uses `runningSet.size === 0` as a hard bail that can skip a job that is genuinely status:"running" in queue.json. Read queue.json (via the existing `readQueue()`) and iterate `state.jobs` filtered by `j.status === 'running'` as the actual source of truth for which jobs to check — the same iteration the function already does after its current fast-path check — rather than gating entry into that loop on the in-memory runningSet. It is fine to keep runningSet as an optimization elsewhere (e.g. still delete reaped slugs from it, still use it in pickNextBatch), but it must never be the sole gate that decides whether a queue.json row with status:"running" gets checked for a dead pid.
- [ ] Preserve every other existing behavior of reapDeadRunningJobs(): pid-alive check via claudePidAlive(pid), skip-if-no-pid (mid-flight spawn guard), classifyRunOutcome(logPath) to decide success/failed, the race-guard re-check inside mutate() (`if (idx < 0 || s.jobs[idx].status !== 'running') continue;`), broadcast({flush:true}) + tickQueue() afterward, and the outer try/catch that logs+swallows errors from this function.
- [ ] Do not remove the function's cheap-early-return intent for the common case where nothing is running — just make the condition it checks reflect queue.json's actual running jobs (or simply drop the early-return and let the existing per-job pid checks inside the loop handle the no-op case cheaply, since readQueue() is already called every pollLoop tick elsewhere in this file and is not expensive). Pick whichever approach keeps the function correct without adding a second full queue read per tick beyond what's already happening.
- [ ] Separately, in spawnJob()'s completion path (scheduler.cjs, the try/catch/finally starting ~2589 and the catch at ~3016-3018), do not silently let an exception between executeJob() resolving and the completion mutate() finishing go unnoticed beyond the existing console.error — this is optional hardening, not required if the reapDeadRunningJobs fix alone makes the system self-heal within one poll tick (~60s) of any such exception; prioritize the reapDeadRunningJobs fix as the primary deliverable and only add extra spawnJob-side logging/handling if it's a small, low-risk addition that doesn't change control flow.
- [ ] Add a regression test (find scheduler.cjs's existing test file, e.g. a __tests__ or test dir alongside src/main — search the repo for existing tests of reapDeadRunningJobs, partitionBootOrphans, or pollLoop to find the right file and follow its existing mocking pattern for readQueue/mutate/claudePidAlive/classifyRunOutcome) that reproduces this exact bug: a queue.json job row with status:"running" and a dead pid, where runningSet does NOT contain that job's slug (simulating the finally-block-already-scrubbed-it state) — assert that reapDeadRunningJobs() (or the equivalent fixed function) still reconciles it to a terminal status (completed/failed per classifyRunOutcome) instead of silently returning early. Also keep/add a test for the still-correct fast-path/no-op case (no running jobs in queue.json) to prove the fix didn't turn every poll tick into an unconditional expensive scan if that matters to the chosen approach.
- [ ] Run the project's test command for this file (check package.json / existing scheduler test invocation, likely `timeout 300 npx vitest run <path-to-scheduler-tests>` per this repo's test:unit convention) and confirm the new test passes and no existing scheduler tests regress.
- [ ] Run `timeout 300 npm run typecheck` and confirm it passes.
- [ ] After the fix lands, start/restart nothing manually — instead, as a live verification, either (a) directly call the fixed reapDeadRunningJobs() equivalent logic against this repo's real session-manager-operations/scheduler/state/queue.json in a throwaway script/test to confirm the 926-epic-prds-tab-include-archived job's status flips from "running" to "completed" (matching its verdicts.json outcome) without any hand-edit to queue.json, or (b) if the running Electron app's own scheduler process will naturally pick up the code change and tick within the session, observe that queue.json's 926 record actually flips within a couple of poll ticks. Either way, do NOT hand-edit session-manager-operations/scheduler/state/queue.json or the 926 job's runs/ artifacts directly to force this outcome — the self-heal must come from the fixed reconciliation code path itself, and if it does not self-heal automatically without a hand-edit, that means the fix is incomplete and must be revisited before calling this PRD done.

# Implementation notes

Primary file: src/main/scheduler.cjs. Key functions/lines to read first (line numbers approximate, may have shifted slightly — grep to confirm before editing):
- `reapDeadRunningJobs()` — scheduler.cjs:3197-3235 (the function to fix). Current body:
  ```js
  async function reapDeadRunningJobs() {
    try {
      if (runningSet.size === 0) return; // fast path: no in-flight jobs
      const state = await readQueue();
      const dead = [];
      for (const j of state.jobs) {
        if (j.status !== 'running') continue;
        const pid = j.runtime?.pid;
        if (!pid) continue; // spawn may be mid-flight; give it a cycle
        if (claudePidAlive(pid)) continue;
        const logPath = j.runId ? path.join(RUNS_DIR, j.runId, `${j.slug}.log`) : null;
        const outcome = logPath ? classifyRunOutcome(logPath) : 'unknown';
        dead.push({ slug: j.slug, pid, outcome });
      }
      if (dead.length === 0) return;
      await mutate((s) => { ... sets status completed/failed, finishedAt, deletes runtime, runningSet.delete(slug) ... });
      await broadcast({ flush: true });
      tickQueue().catch(() => {});
    } catch (e) { console.warn('[scheduler] reapDeadRunningJobs error', e?.message); }
  }
  ```
  The bug: the `if (runningSet.size === 0) return;` line is the ONLY gate before reading queue.json, and `runningSet` can be empty (or missing a specific slug) even when queue.json genuinely has a `status:"running"` row with a dead pid, because `spawnJob()`'s `finally` block unconditionally calls `runningSet.delete(job.slug)` (scheduler.cjs:3019) even when the preceding completion `mutate()` threw and was swallowed by the `catch` at scheduler.cjs:3016-3018 (`console.error('[scheduler] spawnJob error', job.slug, e);` — no rethrow).
- `pollLoop()` — scheduler.cjs:3251-3366 — calls `await reapDeadRunningJobs().catch(() => {});` as its first real action (scheduler.cjs:3253), every `POLL_INTERVAL_MS` (60_000ms, from src/main/lib/schedulerConfig.cjs:11). This is the tick the fixed function will run on.
- `readQueue()` / `mutate()` / `writeQueue()` — scheduler.cjs (search for their definitions), used to read/write the merged queue.json state; `writeQueue` throws at scheduler.cjs:918-920 if the read came back unreadable — this is one concrete way the swallowed exception in spawnJob's completion path can occur.
- `claudePidAlive`, `classifyRunOutcome` — imported from src/main/lib/reaperHelpers.cjs (scheduler.cjs:58) — reuse as-is, no changes needed there.
- `RUNS_DIR` = `path.join(os.homedir(), '.claude', 'session-manager', 'scheduled-plans', 'runs')` — scheduler.cjs ~353.
- For comparison, the existing (boot-only, different code path, do not need to change) reconciliation: `partitionBootOrphans()` (scheduler.cjs:1661-1674) and `applyOrphanOutcome()` (scheduler.cjs:1687-1714), invoked only from `init()` around scheduler.cjs:4094-4149 — these correctly read from queue.json's actual job list rather than an in-memory set, which is the pattern reapDeadRunningJobs should be made to match for its own iteration gate.
- Live proof of the bug already on this repo's queue: `session-manager-operations/scheduler/state/queue.json` job `926-epic-prds-tab-include-archived`, `runtime.pid: 1469438` (dead — verify with `ps -p 1469438`, expect no output), `status: "running"`, artifacts present at `~/.claude/session-manager/scheduled-plans/runs/2026-08-02T04-44-13-742Z/926-epic-prds-tab-include-archived.{meta,verdicts}.json`. Use this as a live fixture reference for the regression test's shape, but build the test against a temp/mocked queue state, not by mutating this real file directly.
- Both `reapDeadRunningJobs` and `partitionBootOrphans`/`applyOrphanOutcome` are already in the module's `module.exports` list (scheduler.cjs ~4454), so they're already unit-testable — find and follow whatever existing test file already imports and tests these (search for `reapDeadRunningJobs` or `partitionBootOrphans` across the repo's test directories) rather than guessing at a new test file location/mocking style.

# Out of scope

- Do not touch the 926 job's queue.json record or its runs/ artifacts by hand — the fix must self-heal it, not a manual edit.
- Do not change partitionBootOrphans/applyOrphanOutcome or the boot-time init() reconciliation sequence — that path is already correct and out of scope.
- Do not add retry/backoff logic for rateLimited exits — that is a separate, already-intentional behavior, not a bug.
- Do not restructure spawnJob()'s overall control flow, slot/runningSet acquisition-release semantics, or verifyRun/verdicts.json writing beyond the optional small hardening noted in the acceptance criteria.
- Do not touch unrelated scheduler.cjs functions (pickNextBatch, archiveCompletedPrd, auto-fix investigation spawning, etc.).

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).

# Validation: watchdog-bypass-one-job-when-saturated (PRD 2517)

Base 85a11908; HEAD c1561579. Commits: 4fcf26cf (fix), c1561579 (test flake fix). PRD file read from `prds-archived/2517-watchdog-bypass-one-job-when-saturated.md`.

## 2517 watchdog-bypass-one-job-when-saturated — VERIFIED (with Important findings below)

- AC1 tickQueue takes `lastResort=false`, passes to tickBody: `src/main/scheduler.cjs:7702,7706,7729`. Only `runQueueStarvationWatchdog` passes `lastResort: true` (`:8209`); `runDueJobs` (`:8054-8065`) and its IPC callers (`:10249`, `:10343`) unchanged (`bypassLoadGate: true` only).
- AC2 `saturated` returned from evaluate, not stored in `last`: `src/main/lib/scheduler/loadGate.cjs:201,237`; win32 returns `saturated: false` (`:184`). `snapshot()` untouched.
- AC3 clamp: `scheduler.cjs:7930-7932` `clampToOne = !!lastResort && load.saturated` → `gatedBatch.slice(0,1)`; without lastResort or with null sample (`saturated` needs `sample !== null`, loadGate.cjs:201) whole batch.
- AC4 audit row inside `if (issued > 0)`, `scheduler.cjs:7998-8003`, with `loadGateAuditFields`, `launched`, `stillHeld`; no toast (none sent in that branch).
- AC5 console line names source (`:7933`); comment above tickQueue rewritten (`:7669-7672`).
- AC6 docs: scheduler-operations.md 85% bullet, section 3 watchdog paragraph, load-deferred row all name `load_gate_last_resort` and the human-full-batch / watchdog-one-job split (diff reviewed).
- Gate (re-run, SM_ unset): vitest on loadGate, scheduler-load-gate-tick, queue-starvation-dispatch-driver, scheduler-tick-wedge, scheduler-shard-quarantine (+ new scheduler-load-gate-last-resort): 6 files / 64 tests passed. `npm run typecheck`: exit 0.

## Caller audit (every path to tickQueue / runDueJobs)

| Caller (scheduler.cjs) | bypassLoadGate | lastResort | Saturated-CPU behavior |
| --- | --- | --- | --- |
| `runQueueStarvationWatchdog` :8209 | true | true | exactly ONE job, `load_gate_last_resort` row |
| `schedule:force-tick` IPC :10249 (via runDueJobs) | true | false | full batch — human |
| `schedule:run-now` IPC :10343 (via runDueJobs) | true | false | full batch — human |
| `runDueJobs()` :930, :961 (upgrade-drain abort/finish), :2829 (resume timer), :10985 (boot-elapsed) | false | false | gate holds |
| `tickQueue()` :5709 (auto-fix), :7554 (job completion), :8091 (when-available poll), :8893, :10758 (slot subscribe), :10968 (dispatch loop `tick`) | false | false | gate holds |

`loadGate.evaluate` has a single call site (:7929). No other module calls tickQueue/runDueJobs (grep over src/main). All automatic callers that bypass pass lastResort; none launches >1 job on a saturated sample.

## Full suite / lint

- `npm run lint`: exit 0.
- `npm run test:unit` (all SM_ vars unset): 862/863 files, 8167 pass, 2 fail — both in `src/main/__tests__/scheduler-load-gate-tick.test.cjs` (a plan-listed file, unchanged by the plan): "saturated hold … launches nothing" (queue.pending 0, expected 2, line 205) and "endHold … on a launch" (`fired` false, line 270). Re-running that file alone at HEAD: failed 3 of 17 runs (first 6 runs, 2 of them failing; last 8 clean). At base 85a11908 (detached worktree): 0 of 8 failed. Intermittent; cause not isolated.

## Findings

### Important
1. `src/main/__tests__/scheduler-load-gate-tick.test.cjs:205,270` — intermittent failure at HEAD (≈3/17 solo runs, 0/8 at base). The file is untouched by the plan, but the plan changed the tick path it exercises and the plan's own gate names it, so the gate is not reliably green. Possible load-sensitivity (other jobs ran concurrently) but unproven. Needs a flake diagnosis.
2. `src/main/scheduler.cjs:10010-10017` — periodic resume-recovery pass loops over every eligible needs_review row and calls `spawnResumeRecovery` (→ `spawnJob` at :7647) for each, with no load gate at all (`loadGate.evaluate` is never reached on this path); only the session-slot pool bounds it. So an automatic path can launch more than one job in a pass on a saturated CPU. Same shape: `spawnInvestigation` (:2469, :7531, :7537) and mechanical recovery (:9996) are single launches per event, ungated. Pre-existing and outside the PRD's diff; the PRD's criteria pass regardless.

### Minor
1. PRD step 11 called for the tick tests in `scheduler-load-gate-tick.test.cjs`; they landed in a new file `scheduler-load-gate-last-resort.test.cjs` (not in the PRD's Files list). Coverage is present.
2. `scheduler.cjs:8202` comment line is one very long line (lint passes).

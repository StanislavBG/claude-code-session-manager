# Validation: on-reset removal + legacy queue migration deletion

Base: 6348683e (known). Gate commands of the three PRDs were not re-run individually: the full `npx vitest run` at HEAD (below) covers every spec they name; typecheck/lint not re-run (PRD gates are specs-only for the criteria checked here).

## 2165 fire-policy-drop-on-reset-renderer — VERIFIED
Commit 8014b48f.
- `ScheduleFirePolicy` no longer includes on-reset; `src/preload/api.d.ts:629-637` mentions only manual/when-available; no `scheduledFor` in preload.
- `computeStatus.ts:5` `StatusKind` has no `on-reset`.
- `dataModelErd.ts:485` lists `'manual' | 'when-available'`.
- `grep -rn "on-reset\|scheduledFor" src/renderer src/preload` → no output.
- Renderer specs (computeStatus.throttled, SchedulerTopBands, SchedulePanel.backlog-tree) are in the full run; none failed.

## 2168 fire-policy-on-reset-timer-delete — VERIFIED
Commit 0129a8b5 (merge 49bdbd25).
- `grep fireTimer|clearFireTimer|computeFireAt|scheduledFor src/main/scheduler.cjs` → none.
- `scheduler.cjs:1128-1131` `normalizeConfig` maps on-reset → when-available; applied at :1135 and :1144 (both queue reads); comment at :1125-1127 says persisted by next mutate(); exported at :11028.
- `src/main/__tests__/scheduler-fire-policy-normalize.test.cjs` exists and passes (full run).
- `healthTickLiveness.spec.ts:44` uses `firePolicy: 'when-available'`; passes; `health.cjs` unchanged since Base (empty diff stat).
- Note: the "only one on-reset hit in src/main" criterion is met for non-test code (the sole hit is the normalization at scheduler.cjs:1129, which carries the migration comment); test files `ipcSchemasFirePolicy.test.cjs` and `scheduler-fire-policy-normalize.test.cjs` also name it, legitimately.

## 2169 delete-legacy-global-queue-migration — VERIFIED
Commit d7cf1dbd.
- `grep -rn "migrateLegacyGlobalQueue\|legacyQueuePath\|LEGACY_QUEUE_PATH" src scripts tests` → no output.
- schedulerPaths / queueStore specs in full run pass.

## Combined grep (implementation-note check)
`grep -rn "on-reset\|scheduledFor\|migrateLegacyGlobalQueue\|legacyQueuePath" src scripts tests` does NOT find only the single comment. Remaining hits: `scheduler.cjs:1129` (normalization), two on-reset schema-rejection tests, and many `scheduledFor` hits — `queueStore.cjs:14,233,454,465,499,550` (persisted state field still read/written by the store, outside every PRD's Files list), test fixtures, `tests/e2e/*`, and a fixture JSON. Not a failure of the three PRDs' stated criteria (their scopes were renderer/preload and scheduler.cjs) but `scheduledFor` is not fully deleted from the main-side store: Minor finding.

## Full unit suite at HEAD (`timeout 900 npx vitest run`)
790 files: 3 failed, 787 passed; 4 tests failed, 7501 passed. (Run a second time to list names; same set.) Each failing file re-run at Base 6348683e in a detached worktree: **all 3 pass at Base (17/17) → all regressions**. None come from the three PRDs under validation.

| Failing spec | Cause | Epic PRD |
| --- | --- | --- |
| `src/main/__tests__/scheduler-effective-concurrency.test.cjs` ("clamps env var into [0, 10]": got cap 32) | `8889f0dd` raised session-slots ceiling to 32; spec still expects 10 | 2164-session-slots-ceiling-32 — REFUTED |
| `src/main/__tests__/chat-queue.test.cjs` (2 tests: FIFO cap, cancel queued run) | `19e120cf` dropped chatRunner's private concurrency cap; spec still assumes the cap | 989-retire-scheduler-private-concurrency-cap (commit in this Epic's range; PRD file lives in another Epic) — REFUTED |
| `tests/unit/atomic-write.spec.ts` ("source no longer contains inline tmp+renameSync recipe") | `eb183c6e` deleted the `atomicWriteJsonSync = (...) => config.writeJsonSync` wrapper the regex requires | 2152-delete-dead-scheduler-kill-switches — REFUTED |

`opsRootAbsoluteCwd` did not fail.

## Findings
### Important
- Three regressed specs above (scoped gates hid them again). Each needs its spec aligned with the new contract (cap 32; chat-queue without private cap; atomic-write regex updated for removed wrapper).
### Minor
- `queueStore.cjs:14,233,454,465,499,550` still carry `scheduledFor` in persisted state; dead field, not removed by any PRD.
- `src/main/lib/__tests__/fixtures/scheduler-machine.json.corrupt-1789147548` is a stray fixture containing `scheduledFor`.
- PRD files for 2164 / 989 are in other Epics' folders; verdict attribution via git log, not the PRD text.

# Validation: starvation-alert-truth plan (PRDs 2501-2506)

Base: 1153800c9cdd1e730772a1ca2e31e3bc6acdb86d. All six PRD files found under `prds-archived/`. Commits: 6d8c2a91 (2501), eefb0b5b (2502), 7d87620e (2503), 5d24a229 (2504), 2871a039 (2505), babe942d (2506). Self-review only (`/code-review`, `/security-review` not run; combined diff read for correctness, input handling, duplication).

## Full suite
`env -u SM_CHAT_SESSION_ID -u SM_PROJECT_ROOT timeout 300 npx vitest run` -> **862 files passed, 8143 tests passed, 1 skipped, 0 failed** (146 s). `npm run typecheck` exit 0. `npm run lint:docs` ok. No new red.

## meter-429-uses-cached-reading — VERIFIED
- `src/main/usage.cjs:313-316`: `withCachedPayload` attaches `cache.data.usage`, requires `cache.data.usage`.
- `usage.cjs:326,334` (billing:fetch / other paths) still return `cached: cache.data`.
- pollLoop branch `scheduler.cjs:8973` unchanged in the diff; `scheduler-meter-429-dispatch` passes unchanged.
- Real shape, read-only: `~/.claude/session-manager/billing-cache.json` has `{data:{usage,subscriptionType,...},fetchedAt,sourceCredsExpiresAt}`. `meterFailureBudget({cachedPayload: data.usage, ...})` -> `{"utilization":75,"degraded":false,"name":"weekly_all"}`; with `data` (the old wrapper) -> `null`. Confirms the bug and the fix on real data.
- Gate: `usage-cached-payload-shape` + `scheduler-meter-429-dispatch`: 9 passed.

## tick-names-meter-cap — VERIFIED
- `budget.cjs` `describeSlotHold`: `usage-meter-degraded` iff `degradedCap != null && inUse < total`, else `slots-exhausted` with real `inUse of total`; detail matches the PRD example.
- tickBody uses it for log, reason and detail (scheduler.cjs diff, `budget.describeSlotHold`); `forceTickOutcome` has a `usage-meter-degraded` case reusing `result.detail`.
- UI case: the switch no longer lives at Home.tsx:956 (moved by 28c10ebf into `queueConstraintLabel.ts`); the case is at `queueConstraintLabel.ts` (`case 'usage-meter-degraded'` returns `lastTick.detail`).
- Gate: slot-hold test 4 passed; typecheck exit 0.

## machine-state-last-dispatch-per-project — VERIFIED
- `queueStore.cjs`: `shapeMachine`, both merged-read defaults, `writeSplit` carry `lastDispatchAtByCwd`; non-object/array -> `{}`.
- `scheduler.cjs` tickBody: one `mutate` stamps `lastRunAt` and `lastDispatchAtByCwd[job.cwd || DEFAULT_PROJECT_CWD]` per `gatedBatch` job.
- Gate: `queue-store-last-dispatch` 3 passed.

## starved-project-needs-no-recent-dispatch — VERIFIED
- `schedulerBatch.cjs findStarvedProjects(..., lastDispatchAtByCwd = {})`: `sinceMs = max(oldestMs, Date.parse(stamp))`, NaN = no dispatch.
- Callers pass the map: `scheduler.cjs` (`s.lastDispatchAtByCwd`), `health.cjs` 5th param + call site `queueState.lastDispatchAtByCwd`. Toast reads "no dispatch for ~Nm".
- Gate: fairness + health-starve-escalation 27 passed.

## starve-alert-names-real-hold — VERIFIED
- `starvation.cjs describeStarveHold`: dependency-blocked via `findBlockingDep(..., DEP_HISTORY_FAIL_OPEN)`, launch-blocked, last tick reason if not fired, else `lastHoldTick.reason`, else dispatching-elsewhere; `unknown` only for null `lastTick`. No load cycle (module loads, tests pass).
- `scheduler.cjs`: `lastHoldTick` set in recordTick when not fired and reason not already-running/drained; `runStarveEscalationSweep(starved, s.jobs, s.launchBlocks)` filters rows by cwd.
- `scheduler-starve-escalation.test.cjs:123` allow-list includes the new set.
- Gate: 3 files, 19 passed.

## doc-hold-reasons — VERIFIED
- `scheduler-operations.md` utilization-held row now says the fix landed with `meter-429-uses-cached-reading`, names `usage-meter-degraded` and the three remaining cases. New `project_starve_escalated` row defines all reasons and `unknown`.
- Gate: `npm run lint:docs` exit 0.

## Replay check (read-only)
Six `project_starve_escalated` events, 2026-11-01T00:05Z-02:05Z. Last dispatch approximated by the latest `startedAt` at or before each event in that project's `state/history.jsonl` (the stamp did not exist then; a still-running row would exclude the project anyway). Threshold 60 min:

| Event (Z) | Project | Last start | Gap | New rule |
|---|---|---|---|---|
| 00:05:07 | starry-night-2 | 23:59:52 | 5 m | not reported |
| 00:25:15 | session-manager | 00:18:13 | 7 m | not reported |
| 00:55:19 | Self | 00:48:27 | 7 m | not reported |
| 01:35:17 | burrow | 00:03:03 | 92 m | **reported** |
| 02:05:21 | starry-night-2 | 01:59:14 | 6 m | not reported |
| 02:05:21 | burrow | 00:03:03 | 122 m | **reported** |

Result: only burrow at 01:35Z and 02:05Z. Matches the expectation. Old reasons were `unknown` / `slots-exhausted` / `memory-deferred`; whether burrow's real hold would read dependency-blocked was not replayed (needs the live queue then).

## Findings
### Critical
- none
### Important
- none
### Minor
- `scheduler.cjs` tickBody stamps `lastDispatchAtByCwd` for every `gatedBatch` job, but after a load-gate yield only `launchBatch` (one job) launches. Projects whose jobs were held get a dispatch stamp they did not earn, which delays their starvation alert by up to the threshold. Stamp `launchBatch` instead.
- 2502 AC cites `Home.tsx:956`; the switch moved to `queueConstraintLabel.ts` in a sibling plan. Behavior is met; the criterion text is stale.

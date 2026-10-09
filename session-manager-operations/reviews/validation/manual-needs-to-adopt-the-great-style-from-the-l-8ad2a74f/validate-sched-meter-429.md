# Validation: sched-meter-429-not-account-limit (PRD 1647)

Base: 6b6a18cb. Landed commit: 3b7e9cc0 (scheduler.cjs, usageCircuit.cjs, usage.cjs, new test, scheduler-operations.md).
Note: `usage.cjs` was changed but is not in the PRD's `# Files` list (Minor, see below).

## sched-meter-429-not-account-limit — VERIFIED

- AC1: `src/main/scheduler.cjs:3499-3510` `computeDegradedBudget` passes `observed429: false, resetsAt: null`; no `lastFailureKind === 'meter_rate_limited'` coupling remains, so nothing pins to 100 until the weekly reset. No executor-observed variable existed; the existing `paused.reason === 'rate_limit'` pause holds dispatch itself (`scheduler-rate-limit-pause.test.cjs` green).
- AC2: `scheduler.cjs` pollLoop meter_rate_limited branch calls `meterFailureBudget` (`lib/usageCircuit.cjs`, 30 min `maxStaleMs`); a hit sets `lastGoodUsagePayload`, `cachedUtilization` to the cached binding window and `degradedConcurrencyCapValue = null`; a miss falls to `applyDegradedBudget()`. `usage.cjs` `withCachedPayload` now attaches `cached`/`staleSince` to the suppressed and fresh 429 returns. Cache at 95% still holds (test c).
- AC3: backoff lines (`backoffMs = nextBackoffMs`, `backoffNextAt`), `warnFailureStreakIfNeeded` and the failure counter are untouched in the diff.
- AC4: `src/main/__tests__/scheduler-meter-429-dispatch.test.cjs` covers (a) 9% 5-min cache, (b) no cache cap 2, (c) 95% held, stale >30m cap 2, (d) `meterFailureBudget` and `degradedBudget` units.
- AC5: the `scheduler-operations.md:177` table row is present.

Gate (re-run, foreground): `npm run typecheck` exit 0; vitest on the 5 named files 5 files / 26 tests pass; `npm run lint` exit 0.
(The worktree has no `node_modules`; I temporarily symlinked the main checkout's and removed it afterwards.)

## Specific checks requested

- Genuinely high cached utilization still holds: test (c) 95% → `utilization-held` on weekly_all, `utilizationHold` payload set.
- Missing/very stale meter never reads as 0%: `meterFailureBudget` returns null with no cache, a non-finite `staleSince` or an age over 30 min. `degradedBudget` returns 100 when no payload was ever received, otherwise carries the last known value with cap 2.
- Executor rate-limit pause: untouched; `scheduler-rate-limit-pause.test.cjs` passes.

## Findings

Critical: none.
Important: none.
Minor:
- `src/main/usage.cjs:305-318` was edited outside the PRD's `# Files` list. The change is required for AC2, because `r.cached` was not previously returned on every 429 path, and it is small.
- `src/main/scheduler.cjs:3505`: `observed429` is now a constant `false` and `degradedBudget`'s `observed429` branch is only exercised by unit tests. This is acceptable because the executor pause is the real signal, but it is dead-ish wiring.
- Beyond the 30-minute window the degraded budget still carries forward the last good payload's old utilization (cap 2). This is the pre-existing behaviour and is bounded by the cap.

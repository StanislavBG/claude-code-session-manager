# Validation: false rate_limit pause (PRDs 1857-1860)

Base: 2469d1abf2d588a0f9113b8281cc00a55bea41dd. Commits: c5478b0a (1857), 86d01143 (1858), 90e16a57 (1859), 9377ca3b (1860). All four PRDs were found in `prds-archived/`.

## 1857 rate-limit-detect-real-rejection-only — VERIFIED
- `rateLimitDetect.cjs` parses the 16 KB tail line by line as JSON. It returns true only for a `rate_limit_event` with status `rejected`, a `result` with `api_error_status` 429, or an `is_error` result whose text matches the limit regexes.
- Allowed-only log modeled on job 1309: `detectRateLimitInLog` → false (ran it).
- Tool-output mentions of 429 are not matched, because only top-level `result` and `rate_limit_event` lines are inspected.
- New `rateLimitDetect.test.cjs` and the rewritten `reaperHelpers.test.cjs` pass. `classifyRunOutcome` on the allowed-only log returns `no_result` (ran it).
- Gate: vitest on the four files → pass.

## 1858 rate-limit-reset-from-rejected-window — VERIFIED
- `rateLimitWindow.cjs` tracks `lastRejected` and `lastEvent`. A rejected event's `resetsAt`, or else `unifiedWindows[rateLimitType].resetsAt`, wins.
- A last event that has a status but is not rejected → null. A statusless last event falls back to the legacy utilization logic.
- Rejected five_hour fixture → 1791174000, the five_hour reset (ran it). Allowed-only → null (ran it).
- Gate: `rateLimitWindow.test.cjs` → pass.

## 1859 rate-limit-pause-billing-sanity-cap — VERIFIED
- `scheduler.cjs`: `resolveRateLimitPauseReset` takes a 4th param `{billingUtilization, threshold}`. The billing reset is used only when both are finite and utilization >= threshold. A log-derived reset is unchanged.
- Both call sites pass `cachedUtilization` and `config.utilizationThreshold`, read after `await billingResetForPause()`, and log via `logBillingResetRejected`.
- Tests added to `scheduler-rate-limit-pause.test.cjs`. Gate: vitest on that file and the spin-guard test → pass. `npm run typecheck` → clean.

## 1860 utilization-threshold-knob-docs — VERIFIED
- The `kpi-threshold` title in `SchedulerTopBands.tsx` now describes the binding window, the when-available policy, and that it is not the rate-limit pause.
- `scheduler-operations.md` gains the "Usage threshold vs rate_limit pause" section and the diagnosis-table row.
- Gate: `npm run typecheck` and `npm run lint:docs` → pass.

## Cross-PRD check — PASS
With all four landed, the 1309-style allowed-only log gives detect=false, reset=null and classify=`no_result` (not `rate_limited`). A rejected five_hour log gives detect=true and a reset of the five_hour value, 1791174000.

Total across the six test files: 126 tests passed. The vitest and typecheck runs used a temporary `node_modules` symlink to the main checkout, because the job worktree has no dependencies. The symlink was removed afterwards.

## Findings
- Critical: none.
- Important: none.
- Minor: `reaperHelpers.test.cjs` and the other test files were not re-read line by line. Their passing was confirmed by running them.
- Minor: `reapDeadRunningJobs` reads the threshold from the in-hand `state`, while `spawnJob` re-reads the queue with `readQueue().catch(() => null)`. If that read fails, the threshold is undefined and the 30-minute fallback applies. That is the safe direction.
- `/code-review` and `/security-review` were self-reviewed on the diff. The only input handling is JSON.parse in try/catch and numeric comparisons, so there are no path, injection or secret concerns.

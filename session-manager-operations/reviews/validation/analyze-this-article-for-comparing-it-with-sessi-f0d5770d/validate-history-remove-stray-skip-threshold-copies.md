# Validation: history-remove-stray-skip-threshold-copies (PRD 3477)

Base: ae933a61. Commit in range: b6a9b8d4 (only commit touching the PRD's files).

## Verdict: VERIFIED

- AC1 — `skipBeforeMs` / `readNewestFinalizedCycleStart` appear in `src/main/historyAggregator.cjs` only at lines 615-663, inside `finalizeClosedDays` (declared line 587). The grep shows no other hit in `computeIntradayBuckets` or `aggregate`.
- AC2 — `git diff ae933a61..HEAD -- src/main/historyAggregator.cjs` has two hunks (`@@ -767,22` and `@@ -929,22`), both pure deletions, zero added lines. `finalizeClosedDays` untouched.
- AC3 — `src/main/__tests__/historyAggregatorIntraday.test.cjs` new test wraps `historyRollup.readNewestFinalizedCycleStart` with a counter, runs `computeIntradayBuckets()` and `remote.aggregate()`, restores the original in `finally`, expects 0 calls.
- AC4 — Gate run: vitest on the 6 files: 6 files, 61 tests passed (exit 0). `npm run lint` and `npm run typecheck` exit 0 (see gate output below).

## Callers under src/main/ of readNewestFinalizedCycleStart / newestFinalizedCycleStart (non-test)

- `src/main/historyAggregator.cjs:617` — `readNewestFinalizedCycleStart`, inside `finalizeClosedDays` (expected).
- `src/main/lib/historyRollup.cjs:131` — definition of `newestFinalizedCycleStart`.
- `src/main/lib/historyRollup.cjs:143,146` — definition of `readNewestFinalizedCycleStart`, which calls `newestFinalizedCycleStart` (the reader itself).
- `src/main/lib/historyRollup.cjs:196-197` — exports.

No other caller. Matches expectation.

## Review
Combined diff is 2 deleted blocks plus one test. No input handling, secrets, or path changes; no security concern. No duplicated helper.

## Findings
Critical: none
Important: none
Minor: none

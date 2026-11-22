# Validation: unknown cache-write split

Base: 481afa57 (commits cd3f8213, dd294d98). /code-review and /security-review not run as separate agents; self-reviewed the diff (no input handling, paths or secrets touched).

## cost-unknown-write-part-explicit — VERIFIED
- Unknown part read, clamped [0, cacheCreationTokens], charged at 1h rate, sets estimated: modelPricing.cjs:122-131.
- 1h part clamped to cacheWrite - writeUnknown; cost (unknown+1h)×1h-mult + 5m×5m-mult: modelPricing.cjs:124,128-136.
- Non-numeric cacheCreation1hTokens => all unknown, estimated when >0: modelPricing.cjs:125-128.
- Tests 7.10 estimated / 5.90 not estimated / clamp: modelPricing.test.cjs:99-135 (pass).
- Doc comment names field: modelPricing.cjs:97-108.
- Gate: vitest (6 files, 65 tests) pass; lint, typecheck exit 0.

## history-folds-mark-unknown-write-split — VERIFIED
- foldBucketIntoRow: new bucket starts both at 0; old line adds to unknown, new to 1h: historyDashboard.cjs:55-69.
- rollupMapToRows same: historyAggregator.cjs:537-553.
- Previous-period 14.20: historyDashboard.test.cjs mixed-period test (pass).
- Estimated mark via costOfUsage in computeRowCost (historyDashboard.cjs:84); three types gain optional field: api.d.ts:1288-1291, 1345-1348, 1371-1374.
- Tests: historyDashboard.test.cjs (mixed prev period, current-day old line), historyAggregatorIntraday.test.cjs (old and new line, summed). rollupMapToRows already exported (test calls it).
- Gate: same vitest run + lint + typecheck green.

## Code-read checks
- No src/main place relies on undefined cacheCreation1hTokens as "unknown" except costOfUsage itself, which maps it to unknown explicitly (modelPricing.cjs:125-128).
- Only costOfUsage callers: historyDashboard.cjs:84 and historyAggregator.cjs:982. Dashboard folds carry both fields. historyAggregator.cjs:982 prices live-scan buckets, which always carry cacheCreation1hTokens (lines 200, 233, 358, 448-454, 489) and no unknown part; correct.

## Findings
Critical: none
Important: none
Minor: none

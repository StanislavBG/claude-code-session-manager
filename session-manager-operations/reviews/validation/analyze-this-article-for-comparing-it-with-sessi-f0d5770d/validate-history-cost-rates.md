# Validation: history cost rates (base e41c402d)

Commits: ab3c25f7 (model-price-table), b0b1c6fa (history-records-1h-cache-writes), 5532aa60 (history-cost-from-price-table).
Gates re-run: vitest on all 7 history/pricing files (62 tests pass), modelPricing test (15 pass), `npm run lint` exit 0, `npm run typecheck` exit 0.

## model-price-table — VERIFIED
- src/main/lib/claude/modelPricing.cjs:30-47: 16 rows, every one equals the PRD list (checked row by row); frozen; multipliers 1.25 / 2 at :49-50; header names source, both dates, both limits (:1-21).
- priceForModel (:75-86): prefix strip, exact / `-8digits` / `[` / `@` match, family fallback estimated, default sonnet-5-5.
- costOfUsage (:96-124): 1h clamped to cacheCreation; non-number 1h with writes > 0 → all 1h, estimated true; non-numeric fields = 0; savings = reads × (input − cacheRead).
- scripts/lib-layout.json:99 `modelPricing: claude`; .claude/agents/page-history.md:43 invariant; test file present and green.

## history-records-1h-cache-writes — VERIFIED
- historyAggregator.cjs:194-200 reads ephemeral_1h_input_tokens (0 if absent) via USAGE_FIELDS (:156); buckets at :233, :292, :340, :358-364, :424, :441, :448-454; rollup lines :489.
- :546-548 and historyDashboard.cjs:64 leave field undefined when no line carries it.
- historyRollup.cjs:47 ROLLUP_VERSION = 4, comment at :40-43; OVERCOUNT_FIX_VERSION = 3 (:53) used by legacyFinalizedDates (:121); isDateFinalized compares with ROLLUP_VERSION (:106); header :21 names modelPricing.cjs.
- api.d.ts:1289, 1344, 1368 add `cacheCreation1hTokens?: number`.
- Tests for dedupe, v4, v3 not-finalized-not-legacy, v2 legacy pass.

## history-cost-from-price-table — VERIFIED
- historyAggregator.cjs:978 and historyDashboard.cjs:79 both call costOfUsage — one shared function, no second formula (grep for `* 1.25`, `cacheCreationTokens *` under src/ non-test: none).
- `grep -rnE 'MODEL_PRICING|resolvePricingKey|DEFAULT_PRICING_KEY' src` → clean; effectiveModelInfo.cjs:312 names modelPricing.cjs.
- estimated is carried only when costOfUsage says so (aggregator :981, dashboard :80).
- Missing 1h field: historyAggregator :546 / dashboard :64 keep it undefined → costOfUsage marks estimated, charges 1-hour rate (not a silent 5-minute price).
- Dashboard test covers 20 / 0.20 / 6.20 figures; green.

## Findings
Critical: none.
Important: none.
Minor:
- src/main/historyAggregator.cjs:546-548 and src/main/historyDashboard.cjs:64-65: if one model has both pre-v4 rollup lines (no 1h field) and v4 lines in the same bucket, the 1h sum covers only the v4 part, so the rest is priced as 5-minute writes with no estimated flag (slight under-estimate). Rare, since finalized pre-v4 days are rescanned while transcripts exist.

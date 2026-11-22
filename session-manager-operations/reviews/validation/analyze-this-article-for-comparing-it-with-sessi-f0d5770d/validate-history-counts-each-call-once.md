# Validation: history counts each call once

Base: 096c36ec (given). Commits found via `git log 096c36ec..HEAD` on each PRD's paths: 05c685ed (aggregator), ecaaef81 (usageForOne), 482fd532 (rollup v3), 1206e15b (note). Gates re-run: 11 vitest files / 91 tests pass; `npm run typecheck` and `npm run lint` exit 0. /code-review and /security-review were not run as separate tools; I self-reviewed the diff (no new input paths, no secrets, no file paths built from input).

## history-count-each-call-once — VERIFIED
- Repeated id adds only the increase (max per field), totals and per-model bucket: src/main/historyAggregator.cjs scanAggrLines (~l.218-260).
- No id: `add = vals`, same as before (l.~231).
- Last 64 ids kept (RECENT_IDS_MAX); stored on the cache entry (`recentIds`) and copied into the tail-parse delta (l.~353, 392, 426).
- promptCount, tool counts, error count and timestamps: diff touches only the usage block.
- Test: src/main/__tests__/historyAggregatorDedupe.test.cjs (new, passes); existing aggregator/rollup/dashboard tests pass.

## epic-usage-count-each-call-once — VERIFIED
- usageForOne: src/main/transcripts.cjs ~l.561-600, id repeat takes the larger value per field; no id adds as before.
- Cache entry holds `recentIds` capped at USAGE_RECENT_IDS_MAX = 64.
- Tests in transcriptsUsageFor.test.cjs pass.

## history-rollup-v3-legacy-days — VERIFIED
- ROLLUP_VERSION = 3 with comment: src/main/lib/historyRollup.cjs l.~44.
- `legacyFinalizedDates(map)` exported, sorted, v<3 only, no marker is not legacy (l.~102, 163).
- computeDashboard returns `legacyDates` filtered to range: src/main/historyDashboard.cjs l.~203, 215.
- `legacyDates: string[]` in HistoryDashboardResult: src/preload/api.d.ts l.~1371.
- Tests in historyRollup, historyDashboard, historyFinalizeResume (v3 marker, l.122-130) pass.

## history-legacy-days-note — VERIFIED
- Line with count and last date, "older method", "two to three times too high", "cannot be recounted": src/renderer/components/tabs/HistoryDashboard.tsx l.337-344, 381-386.
- Hidden when missing or empty (`raw.legacyDates && length > 0`).
- Invariant added: .claude/agents/page-history.md l.37.
- legacyNote.test.tsx passes. A visual check by the owner is still due.

## Extra checks asked for
- No old rollup line deleted or rewritten: the historyRollup.cjs diff removes only a comment line and the version constant; the code adds a read-only helper. Nothing rewrites stored lines.
- Transcript lines with no message id are counted exactly as before in both counters (aggregator `add = vals`; transcripts.cjs no-id branch adds in/out).
- Recent-id memory bounded at 64 in both places (Map eviction of the oldest).

## Findings
### Critical
none
### Important
none
### Minor
- src/main/transcripts.cjs l.~476-620: usageForOne also gained `lastContext`/`calls` and `newestId` (commit 04941c78, a later PRD outside these four); not part of the epic-usage PRD's scope, and the PRD's out-of-scope list named "context size". It is covered by its own tests, so no action beyond noting it.
- src/main/historyAggregator.cjs scanAggrLines: a repeated id evicted from the 64-id memory counts again. This is the intended bound; no action.

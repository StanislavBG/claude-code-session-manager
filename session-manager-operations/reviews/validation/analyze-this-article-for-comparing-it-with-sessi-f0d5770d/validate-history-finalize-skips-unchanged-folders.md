# Validation: history-finalize-skips-unchanged-folders (PRD 3475)

Base: b5fb76f7. Commit under review: c1a9c6be (4 files, all in PRD `# Files`).

## Verdict: VERIFIED

Evidence per criterion:
1. Marker carries cycleStartedAt: `src/main/historyAggregator.cjs` `finalizedMarkerLine(date, cycleStartedAt)` (~l.501-509); call `finalizedMarkerLine(date, cycleStartedAt)` at l.~690. `cycleStartedAt` is `Date.now()` or the cursor's value on resume (l.~584-590). Tests at FinalizeResume l.159, l.168.
2. Threshold: `historyRollup.cjs` `newestFinalizedCycleStart` keeps only markers with finalizedAt, `v === ROLLUP_VERSION`, numeric cycleStartedAt; the caller does `setHours(0,0,0,0)` on it (historyAggregator l.615-625). Null on no marker, missing rollup, or version change.
3. Skip rule: l.663 skips only if no stat'd .jsonl has mtime >= threshold; no parse, no entries, no marker for skipped-only days. Tests l.177, l.192.
4. Read folders complete: the loop over `stated` has no per-file skip; budget/cursor code is unchanged (`walkedLast` advances only after a full folder).
5. Tests present: l.177 (unchanged left alone), l.210 (after threshold recounted), l.217 (same day before pass recounted), l.227 (version change reads all).
6. Closed-day test: l.244.

Gate (rerun): vitest 6 files / 60 tests passed; `npm run lint` exit 0; `npm run typecheck` exit 0.

## Staleness checks (by reading the code)
- Skip only with a completed pass at the current version: threshold comes solely from markers at `v === ROLLUP_VERSION`; markers are written only when `!partial`. Confirmed.
- Local midnight of that pass's day: `new Date(lastCycle).setHours(0,0,0,0)` — not the pass time. Confirmed.
- Version change / missing rollup: reader returns null, `skipBeforeMs` null, no folder skipped. Also null if the read throws. Confirmed.
- Partial pass never stamps markers: markers pushed only inside `if (!partial)`. Confirmed. A pass with all folders skipped writes no markers, so the threshold stays at the older day (conservative, safe).
- No single file skipped inside a read folder: the skip test is folder-level (`stated.some`); the parse loop has no mtime filter. Confirmed.

## Findings
### Critical
none
### Important
none
### Minor
- Minor: `src/main/historyAggregator.cjs` l.~774-785 (`computeIntradayBuckets`) and l.~936-947 (`aggregate`) contain a copy of the skip-threshold block. `skipBeforeMs` is never used there (only l.663 uses it). It adds a rollup-file read on each intraday tick and each aggregate call, and breaks the PRD's "do not touch the intraday refresh, aggregate()" rule. Remove both blocks.

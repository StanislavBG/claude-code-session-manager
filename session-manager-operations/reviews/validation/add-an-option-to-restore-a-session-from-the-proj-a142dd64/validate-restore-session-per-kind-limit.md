# Validation: restorable-sessions-per-kind-limit (PRD 2878)

Base: 721573325d74f79d9127f5c10643aa9b93aa74e1. Commit: dc4589c5 (touches only the PRD's two files).

## restorable-sessions-per-kind-limit — VERIFIED

- Per-kind budgets: `restorableSessions.cjs:631-650` keeps `interactive` and `headless` counters, pushes only while the row's kind is below `max`, and breaks when both are full or `scanned >= MAX_HEAD_READS`. Rows are pushed in walk order (newest first). JSDoc states the per-kind limit at lines 88 and 596-602.
- `MAX_HEAD_READS = 400` (`restorableSessions.cjs:56`). `truncated = i < open.length` (line 659), so it is true exactly when unread unclaimed candidates remained.
- `claimedClaudeSessionIdsAsync` is defined at line 343, shares `claimedCache` with the sync reader (lines 125, 311, 347), and is exported (line 745). `listRestorableSessions` awaits it (line 623). `checkRestorableSessionSync` (line 702) keeps the sync one.
- Existing tests: only two were edited ("limit caps each kind…" and "at most 400 transcript heads…"). Both asserted the old shared limit or the old cap, as the commit message says.
- New tests: (a) test.cjs:272, (b) :283, (c) :326. The PRD's gate is green (below).
- Gate re-run: `vitest run` of the 4 specs gave 4 files and 84 tests passed. `npm run typecheck` exited 0.

## Real-data probe (read-only, scratch script in /tmp)

Cwd /home/bilko/Projects/session-manager. The project dir holds 1563 transcripts, and 376 session ids are claimed.

| run | ms | max event-loop block (5 ms timer) | interactive | headless | hiddenClaimed | scanned | truncated |
| --- | --- | --- | --- | --- | --- | --- | --- |
| cold | 704 | 1 ms | 7 | 50 | 245 | 400 | true |
| warm | 289 | 1 ms | 7 | 50 | 245 | 400 | true |

Before the fix the probe returned 48 headless + 2 interactive rows. Now interactive rows get their own budget, with 7 listed. The async claimed scan did not block the loop: the max timer drift was 1 ms.

Warm is still 289 ms. That is stat plus 400 head reads, since only the claimed memo is cached. It is asynchronous, so it is not a loop-block issue. See Minor 1.

## Independent count

Among the newest 400 unclaimed transcripts, 9 contain `"entrypoint":"cli"` in the first 64 KiB.

- 7 are in the lister's interactive rows.
- 2 are not listed: `14b84e8e-f3f0-4a4a-93cb-669cf9ff741c` and `1c961423-7447-4ebd-a4d6-24e2169916ac`. Both have the correct cwd and contain only `/clear` and `/login` command rows, with no real user prompt. This is the lister's documented skip reason (no real first prompt in the head).
- None of the 9 landed in a headless row.

## Full unit suite

`timeout 900 npm run test:unit` with all SM_* vars unset: 965 files passed, 9244 tests passed, 1 skipped, exit 0. No red specs.

## Findings

- Critical: none.
- Important: none.
- Minor 1: warm call is still 289 ms (`restorableSessions.cjs:606-660`), because the 400 head reads are not cached between calls. It is async, so the loop is not blocked (max block 1 ms). A head cache keyed on mtimeMs:size would cut it, if the picker ever refreshes often.
- Minor 2: 245 claimed files are counted in `hiddenClaimed` and the walk is `truncated` at 400. Interactive sessions older than the 400 newest unclaimed files remain unreachable by design (test (b)).

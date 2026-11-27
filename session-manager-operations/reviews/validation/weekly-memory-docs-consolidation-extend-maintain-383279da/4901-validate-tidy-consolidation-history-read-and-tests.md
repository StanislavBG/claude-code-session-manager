# Validation: tidy-consolidation-history-read-and-tests (4900)

Base: `e03d2569` (main commit just before the PRD's only commit `3cc8bbfc`). Range `e03d2569..HEAD` = 1 commit, 5 files, +75/−13 — exactly the PRD's `# Files`.

## 4900-tidy-consolidation-history-read-and-tests — VERIFIED

| ac | met | evidence |
| --- | --- | --- |
| ac-1 | yes | `weeklyConsolidationInputs.cjs:50-53` sets `slack = HISTORY_SLACK_ROWS` (200, `:22`) at the first pre-window row and stops after 200 more rows; test `weeklyConsolidationInputs.test.cjs:182-200` pins in-window `behind` row collected after `pre`, and an in-order history (`['in']`); 3,000-row in-order test kept (`:165-180`). |
| ac-2 | yes | `:72-78` returns `{ rows, partial }` (ENOENT = empty, other errors = partial); default dep `:114-116` passes the object; `collectLessons :253-258,292` reports `lessonsPartial`; `memoryConsolidation.cjs:126` adds "Lessons read partially", wired at `:287`; tests `weeklyConsolidationInputs.test.cjs:202-215`, `memoryConsolidation.test.cjs:175-178`. |
| ac-3 | yes | `memoryConsolidation.test.cjs:170-172` slices the built prompt's LESSONS_DATA section (hostile Lessons) ahead of the real table and asserts `extractProposal` returns exactly `\| c1 \| verify \| a.md \| drop \| a \| 1 \|`. |
| ac-4 | yes | `session-manager-operations/AGENTS.md:30` md-network README column = `none`; file 3,973 bytes. |
| ac-5 | yes | vitest: `Test Files 2 passed (2) / Tests 33 passed (33)`; `lint:docs`: `doc-hierarchy: ok (27 junctions, 55 files linted)`; typecheck exit 0. |

Gate re-run (this PRD's and the validate PRD's): vitest exit 0, `npm run lint:docs` exit 0, `npm run typecheck` exit 0.

## Diff review

No correctness, unsafe-input, secrets or path-traversal issues. The slack counter only counts parsed object rows (blank/garbage lines don't consume slack) — fine. No duplicated helper. No `Follow-up:` trailers.

## Findings

### Critical
- none

### Important
- none

### Minor
1. `src/main/lib/tasks/__tests__/weeklyConsolidationInputs.test.cjs:191-197` — the "slack is bounded" scenario has only pre-window rows behind the first pre-window row, so it would pass with an unbounded slack too; no test places an in-window row more than `HISTORY_SLACK_ROWS` behind and asserts it is NOT collected (the run report claims it does). (missing-test)
2. `src/main/lib/tasks/__tests__/weeklyConsolidationInputs.test.cjs:212-213` — the partial-flag `collectLessons` assertion uses a hand-written `{ rows: [], partial: true }` instead of the real `readHistorySince` result; the default-dep wiring (`weeklyConsolidationInputs.cjs:114-116`) is covered only by reading. (missing-test)

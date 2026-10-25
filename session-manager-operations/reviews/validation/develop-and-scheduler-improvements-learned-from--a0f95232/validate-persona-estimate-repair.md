# Validation: persona-estimate repair wave

HEAD 8d2ef198, base cef10762. SM_* unset for all runs. PRD files found in `prds-archived/` (2224, 2240, 2241). Commits: dfd0f7fc (2240), 8d2ef198 (2241).

## repair-persona-estimate-scheduler-import — VERIFIED
- Import: `src/main/scheduler.cjs:193` requires both `resolvePersonaDefaultEstimate` and `DEFAULT_PRD_AGENT_TYPE` from `./lib/prd/prdAgentType.cjs` at top level (no cycle: suite loads it fine); use site `:4614`.
- Wiring test: `scheduler-prd-persona-spawn.test.cjs:213-228` spawns via `executeJob` with persona `defaultEstimateMinutes: 20`, captures `computeJobBudgetMs`, expects clamp(20*3 min, floor, ceiling).
- Gate (3 commands, 14 files + personaDefaultEstimate): 24, 32, 26 tests passed, all green, including all 14 previously red files.

## prd-body-patch-deterministic-fixture — VERIFIED
- `prdBodyPatch.test.cjs:35-36` `vi.useFakeTimers` + `setSystemTime(2026-01-01Z)`; `:39` `useRealTimers`.
- Assertion intact: `:72` `assert.equal(body, makeBody())` after refused patch.
- `:67` test uses `{ repeats: 20 }`. Gate: 6 passed.

## persona-default-estimate-minutes — VERIFIED (fresh)
- Schema: `agentPersonaSchema.cjs:62` int 1..60 optional.
- Resolver: `prdAgentType.cjs:89` exported at `:109`; reads frontmatter `:96`, returns number|null.
- Scheduler use: `scheduler.cjs:4614` `job.estimateMinutes ?? resolvePersonaDefaultEstimate(...)`, now with names imported.
- Tests: `personaDefaultEstimate.test.cjs` has global, overlay, malformed, missing, explicit-wins (+schema) cases.
- Gate (personaDefaultEstimate, scheduler-job-budget, prdAgentType, agentPersonaSchema): 4 files, 37 tests passed.

## Full unit suite
`timeout 600 npx vitest run`: 812 passed, 1 failed (813 files); 7642 tests passed, 1 failed.
Failing: `src/main/__tests__/historyFinalizeResume.test.cjs` ("resumes after lastDir, never re-parses a dir..."). Re-run in isolation: 3/3 pass, so it is load/ordering-sensitive (added in 513c95df, outside this wave).

## Combined diff review
Wave diff touches only `scheduler.cjs` (one require line), two test files; no input handling, secrets, or path changes. Self-review: no issues. /code-review not run (diff is a single import + tests).

## Findings
- **Important** — `src/main/__tests__/historyFinalizeResume.test.cjs` fails in the full suite, passes alone (flaky under parallel load); belongs to the 513c95df history-cursor work, not this wave.
- **Minor** — none.

# Validation: weekly consolidation mend wave

PRD 4896-validate-weekly-consolidation-mends. The PRD has no `Base:` line, so the base is taken as `9a301930` (the 4888 review record). HEAD is `2b95ddcf`.
The plan commits are 4da8fc95 (4894) and 2b95ddcf (4895). 03b39155 is outside the plan: it is a release fix that 2b95ddcf supersedes. Neither plan commit has a `Follow-up:` trailer.

## Gates (re-run 2026-11-26, foreground)

- `npx vitest run` on the memoryConsolidation, weeklyConsolidationInputs and opsOwnership tests: 3 files and 52 tests passed, exit 0.
- `npm run lint:paths`: "check-ops-path-literals: clean", exit 0.
- `npm run lint:docs`: "doc-hierarchy: ok", exit 0.
- `npm run typecheck`: exit 0. It was run last, together with the 4896 vitest gate.

## Real-data run (read-only, /home/bilko/Projects/session-manager, last 7 days), covering 4896 ac-2

- History shard `scheduler/state/history.jsonl` is 17.2 MB with 4,205 rows. A full read finds **1,704** rows finished in the window. `readHistorySince` read 1,824 rows; of the 1,704 in-window rows it **missed 0**. No pre-window row comes after the first in-window row, so stopping early is safe on this file.
- `collectLessons` with the default deps returned 0 Lessons. All run logs were readable (50 of 50 sampled). Of the 300 newest run dirs, 12 logs contain the text `Lessons:`. Each of them gives `parseLessonsBlock(extractResultTextFromLog(log))` = [], and the validators have no `lessons` field. Every mention is in the prompt text, so 0 is the true count.
- `listProjectTranscripts`: 200 returned out of 1,858 (1,658 truncated), with 0 foreign. Per day, kept/total (each day starts at 02:39Z): 11-26 34/331, 11-25 34/77, 11-24 33/725, 11-23 33/140, 11-22 33/433, 11-21 33/152. The 11-20 bucket is absent. An independent `find -newermt` over ~/.claude/projects for that day found 205 jsonl files, and none of them are in the session-manager folder or under key `fd076eb59c21f399`. So every day that had transcripts is covered.

## 4894-mend-consolidation-history-window-and-spread: VERIFIED

- ac-1 met: `readHistorySince` (weeklyConsolidationInputs.cjs:29-67) reads 256 KB chunks backwards and stops at the first row with `finishedAt < sinceMs`, or at the file start. It has no row or byte cap. `readHistory` passes `sinceMs` (:102-105, :241). Test test.cjs:162 uses 3,000 in-window rows with multibyte padding and a 4 KB chunk, and collects the Lessons block of the oldest row.
- ac-2 met: weeklyConsolidationInputs.cjs:174-197 spreads the cap round-robin over day buckets, newest first, so unused share passes on to other days. It returns `perDay` and `truncated`. Tests test.cjs:139 (7×300 gives 28-29 per day, 200 total) and :152 (5 and 195).
- ac-3 met: vitest is green.
- ac-4 met: the 4da8fc95 body gives these counts: 1,699 in window, Lessons 0, 200 of 1,853 over 6 days. My re-run gives 1,704 of 1,704 read and 0 missed. The commit could not read the logs; my run read them and found 0 Lessons.

## 4895-mend-consolidation-marker-strip-and-opspath: VERIFIED

- ac-1 met: memoryConsolidation.cjs:58-72 strips PROPOSAL and LESSONS_DATA markers in a loop until nothing changes, and maps `"“”` to `'`. Probe: `a <<<PROPO<<<PROPOSALSAL b PROPOSAL>PROPOSAL>>>>> c "q" <<<LESSONS_<<<LESSONS_DATADATA` becomes `"a b c 'q'"`. The prompt's marker counts equal the baseline, 1 of each. Tests test.cjs:146 and :161. The test checks that marker counts are unchanged and that `extractProposal` works on a result. It does not call `extractProposal` on prompt + result, and the author explained why (the prompt carries its own template).
- ac-2 met: memoryConsolidation.cjs:216 uses `opsPath(cwd, 'md-network', 'steering.md')`. opsOwnership.cjs:148 has `'md-network': 'tracked'` with no OWNERS writer. ops AGENTS.md lists it as `not owned | tracked` and the count is now 21.
- ac-3 met: vitest and lint:paths are green.

## 4886-repair-consolidation-lessons-and-dead-worktrees (re-judged): VERIFIED

- ac-1 met: the log path is still `runsDir/runId/slug.log`, and no `job.logPath` is read.
- ac-2 met now: history is read back to the window start, with 0 of 1,704 missed (see the real-data run).
- ac-3 met: the dead-worktree key mapping is unchanged, with 0 foreign on real data.
- ac-4 met: the tests from the prior record still pass.
- ac-5 met: vitest is green.

## 4887-repair-consolidation-model-test-and-lessons-fence (re-judged): VERIFIED

- ac-1 met: route-level Fable/max test, memoryConsolidation.test.cjs:88.
- ac-2 met now: the fixed-point strip, the quote escape and the 200-char cap are in place (see 4895 ac-1).
- ac-3 met: the tools and `--strict-mcp-config` test (:88) passes.
- ac-4 met: vitest is green.

## 4876-weekly-consolidation-inputs (re-judged): VERIFIED

- ac-1 met: own project and worktrees only, with 0 foreign. Subagents are excluded. The cap of 200 is now spread over the days, with truncated 1,658.
- ac-2 met now: every in-window finished job is read.
- ac-3 met: the window is half-open and the tests pass.
- ac-4 met: vitest is green.

## Findings

### Critical
- none

### Important
- none

### Minor
- src/main/lib/tasks/weeklyConsolidationInputs.cjs:44: `readHistorySince` stops at the first pre-window row, so it assumes history is appended in `finishedAt` order. That holds on real data today (0 out-of-order rows), but one late-appended old row near the tail would cut off the rest of the window. No test pins this assumption. (4894, other)
- src/main/lib/tasks/weeklyConsolidationInputs.cjs:63: an I/O error part-way through the read is swallowed, and the function returns a partial list with no signal. (4894, other)
- session-manager-operations/AGENTS.md: the new `md-network` row uses `—` in the README column, but other rows use `none`. The `feedback` row was cut down to "retired; never touched (project's own)" to fit the size cap. (4895, docs-drift)
- 4895 ac-1: the test checks the prompt's marker counts instead of calling `extractProposal(prompt + result)` as the criterion words it. The author explained why the substitute is equivalent. (4895, other)
- The 4896 PRD has no `Base:` line, so `9a301930` was inferred. (other)

# Validation: artifact-only dispatch window

Base: f7f42190 (known). PRD commits: 3144bc52 (2598), 1011875f (2599). Both PRD files found in prds-archived/.

## spawnjob-verify-dispatch-start — VERIFIED
- scheduler.cjs:6273 `let dispatchStartedAt = null` beside `dispatchStartedAtMs` (6271); set at :6356 from the same `s.jobs[idx].startedAt` as the Ms line (:6355, unchanged).
- scheduler.cjs:6805 `queueEntry: { ...job, startedAt: dispatchStartedAt, finishedAt: null }`.
- New test file scheduler-artifact-only-dispatch-window.test.cjs: positive test (:135) plus 3 negatives (never written, 0 bytes, stale mtime via utimesSync :69) in a loop at :148 — all green.
- Gate: vitest (artifact-only, artifactOnlyVerdict.spec, inplace-salvage, plus 2599 files) 5 files / 30 tests passed; `npm run typecheck` exit 0.
- Not re-verified: the "red before fix" run (executor's own claim; no revert performed here).

## spawnjob-inplace-window-dispatch-start — VERIFIED
- computeCommittedDuringRun exit-0 :6751 and SIGTERM :6968 pass dispatchStartedAt.
- siblingOverlap `const myStart = Date.parse(dispatchStartedAt) || 0` :6761.
- resolveLandedCommitEvidence SIGTERM :6972 and plain exit :7012 pass dispatchStartedAt.
- grep: no `job.startedAt` read in spawnJob after the dispatch mutate (remaining hits at 9422+ are reaper/reverify/other functions, out of scope).
- New scheduler-inplace-dispatch-window.test.cjs tests at :131 and :137 present and green.
- Gate: all 4 specified vitest files + typecheck green (above).

## Combined diff / full unit suite
`npm run test:unit` (SM_* unset): 4 failed / 885 files passed. None concern spawnJob; none assert the old null-startedAt / all-siblings-overlap behaviour:
- scripts/__tests__/check-ops-path-literals.test.cjs "real repo tree is clean"
- macroLibrary.test.cjs "demo-video v4 ... upgrades to v5" (got builtinVersion 6; macro v6 landed in 949792c4 in the same range)
- preload apiSurface.test.cjs (surface table drift)
- ProjectHomeEmptyState.test.tsx (renders no hand-written live blocks)
These come from the concurrent demo-video / project-home work, not this plan.

## Findings
- Critical: none.
- Important: none attributable to this plan. The 4 red specs above are in the combined range and block a clean release; they need an owner (macroLibrary expectation 5→6 is a stale test from 949792c4).
- Minor: 1011875f also edited the artifact-only and inplace-salvage test harnesses (backdated fixture commit) beyond its declared Files list; benign, test-only.
- Self-review: no unsafe input handling, secrets or path issues in the scheduler.cjs changes (7+10 lines, local variable reuse).

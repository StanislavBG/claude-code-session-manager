# Validation: artifact-only no-commit PASS plan

Base: 2cc0298bfd19db62029a55d867387991d66d8bec (known). Commits: cba708a5 (3110), 67d80b02 (3111), 37c9563a (3109), f9387993 (3112), 4435116e (sibling plan 3114, out of scope here but in the range).

## artifact-only-finish-protocol-pass — VERIFIED
- buildFinishProtocol takes `isArtifactOnly=false`; VERDICT bullet appended after the PASS/fix-plan bullets: scheduler.cjs `FINISH_ARTIFACT_ONLY_VERDICT_LINE`, `buildFinishTail`.
- COMMIT sentence `FINISH_ARTIFACT_ONLY_COMMIT_LINE` only when true; the default path is unchanged (schedulerFinish.spec asserts the equality with FINISH_PROTOCOL; passes).
- No added line starts with `SCHEDULER_VERDICT:` or `FOREIGN_WIP_PATHS:` (grep of the combined diff: none).
- Real seam: executeJob reads the PRD FILE via `parsePrdFile(await fsp.readFile(prdPath))` and sets `isArtifactOnly` from `fm.deliverable === 'artifact'` and a non-empty `artifactPaths`. It does not read `job.deliverable`. A read or parse failure gives false.
- scheduler-artifact-finish-prompt.test.cjs drives the real executeJob with a stub SM_CLAUDE_BIN. The queue row carries no artifact fields. It asserts the bullet and the COMMIT sentence are present for the artifact PRD, in the right order, and absent otherwise.
- Gate (vitest, 5 files): 63 passed. `npm run typecheck`: exit 0.

## macro-build-template-no-commit-pass — VERIFIED
- macroJobDispatch.cjs: the second criterion now says no commit is expected and the run ends in PASS; implementationNotes carry the artifact-only sentence. Both put the sentinel mid-sentence.
- The new dispatch test is in the diff (+18 lines).
- Gate (3 files): 44 passed.

## project-home-builder-no-commit-pass — VERIFIED
- project-home-builder.md step 6 says a scheduled build commits nothing and ends in PASS, conditional on a scheduled build. seedVersion 5→6. The body is 5499 bytes, under the 6000 cap. No line starts with the sentinel.
- shippedPersonaSeeds.cjs has the new `seed-v6-no-commit-pass` entry; the earlier entries are unchanged. seedAgentPersonas test extended.
- Gate (4 files): 74 passed.

## finish-rule-docs-artifact-pass — VERIFIED
- PRD_AUTHORING.md: stamp v20 on line 1; the finish sentence names the artifact-only exception. standards.md verdict bullet gains one sentence and keeps its existing rules.
- No added line starts with the sentinel.
- Gate (2 files): 10 passed.
- Minor: the PRD's Files lists prdAuthoringSeed.test.cjs, and it is unchanged. That is fine because no v19 pin existed.

## Full suite (timeout 600 npm run test:unit)
- Run 1: 3 failures in 2 files (scheduler-resume-recovery-saturated: hook timeout, plus one other). Run 2: 1 failure in chatRunner-session-flag-retry. The failures differ between runs, are timeouts under load, and none of those files were touched by the plan. Re-run alone: both files pass (9 tests). 5 SM_* env vars were set in the shell; classified as load flakes, not regressions.

## Combined diff review
14 files, +379/-17. The code-review and security-review commands were not run; self-review found no secrets, no path traversal and no unsafe input handling. The PRD path comes from the scheduler's own resolution and is read-only. Existing helpers (parsePrdFile) are reused.

## Findings
- Critical: none.
- Important: none.
- Minor: the full suite is flaky under load (timer-sensitive scheduler tests), unrelated to this plan.
- Minor: the isArtifactOnly condition is duplicated from runVerify.cjs's artifact exemption (comment-linked, not a shared helper): scheduler.cjs executeJob.

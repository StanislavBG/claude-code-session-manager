# Validation: plan records machine-local (plan-records-pile-up-in-every-project-and-never--44c13ab4)

Base: 9d4bc97d650896392edf90f5041a107e6f4fa5c4. Combined diff is mixed with an unrelated Project Video plan; only plan-record paths reviewed. PRD files were all found under prds-archived/. Review via self-review (code-review/security-review slash commands not run); checked path handling, symlinks, ownership guard, force-add wording.

Gates re-run: vitest over 13 gate test files → 12 files / 86 tests pass (some PRDs share files); `npm run lint` clean (tail shows lint:scroll/lint:readme OK); `npm run typecheck` clean (both tsconfigs). `lint:docs` is part of `npm run lint`.

## plan-records-runtime-namespace — VERIFIED
- opsOwnership OWNERS/RUNTIME_NAMESPACES include plan-records (grep hits src/main/lib/opsOwnership.cjs); opsOwnership + opsRuntimeIgnore tests pass.
- .gitignore:61-62 `plan-records/*` + `!README.md`; README exists; ops CLAUDE.md updated (diff in stat).

## plan-record-harvest-helper — VERIFIED
- src/main/lib/scheduler/planRecordHarvest.cjs exists; planRecordHarvest.test.cjs passes (copy, overwrite, symlink, oversize, unsafe id, same-dir, missing source).

## wire-plan-record-harvest — VERIFIED
- scheduler.cjs:408 harvestJobPlanRecords, called at :7055 in the run `finally`, immediately before finalizeJobWorktree (worktree integration/removal) and long before verifyRun (:7293). Failures caught/logged (:418-420).
- scheduler.cjs:433-438 force-add wording + "never staged" sentence. runVerify.cjs:549-566 plan-records paths verify only against first root. Tests runVerify-plan-record-artifact, finishTail-ops-force-add exist and pass.

## validator-prds-write-plan-records — VERIFIED
- epicSweepValidator, fixPlanSlug, prdCreate reference plan-records; epicSweepValidator + prdCreate-plan-records + prdFrontmatterArtifact tests pass.

## record-readers-read-plan-records — VERIFIED
- mdReviewRecord.cjs and epicValidationHook.cjs reference plan-records; mdReviewRecord + epicValidationHook-digest-path tests pass.

## plan-record-retention-helper — VERIFIED
- planRecordRetention.cjs:73-80 isEligible: only `status==='completed'` with parseable old completedAt, or null-status orphan with old mtime; proposed/active/non-completed return false; throwing epicStatus keeps. README.md/.gitignore reserved (:35), unsafe names skipped. Removal via opsPath + assertOpsWrite('scheduler'). Tests pass; planRecordsDays in opsRetentionSettings (test passes).

## wire-plan-record-retention — VERIFIED
- runLogRetention.cjs:545 runBootSweep calls runPlanRecordSweep over state.sourceCwds (no allProjectCwds scan); epicStatusFor reads active-index via epicMint.readActiveIndex then prompt-sessions archive. index.cjs:1309 logs result. opsRetentionKnobsWired + planRecordRetention-wiring tests pass.

## personas-skills-plan-records — VERIFIED
- validator.md seedVersion 6→7, steps 4/5 reworded; develop SKILL.md lines 197-208, 267, 275 name plan-records/<epic-id>/; drift-check.md:136 check-ignore rule. lint passes.

## docs-plan-records — VERIFIED
- PRD_AUTHORING.md v22 (line 1); reviews/README.md:33-34 legacy note; domain-model.md:325 lists plan-records; grep for 'record is committed'/'write and commit' over templates, plugins, architecture → no hits.

## record-path-comments-plan-records — VERIFIED
- Commit 5f1936a2 touches only comment lines in api.d.ts, ipcSchemas.cjs, projectPages.cjs (diff reviewed); typecheck passes.

## Findings
### Critical
- none
### Important
- none
### Minor
- src/main/lib/scheduler/runLogRetention.cjs:545 sweep runs only at boot (via runBootSweep), not on a 24h timer as the PRD wording "same schedule" is satisfied but long-running apps prune only on restart; commit 75027f57 says "boot/24h sweep" — confirm the 24h path calls it.
- planRecordRetention.cjs:73-76 an active Epic with no active-index row and no prompt-sessions file is treated as orphan and pruned after 14 days of mtime inactivity; acceptable but note.
- Working tree shows project-pages/home.html and demo-video/index.html deleted (foreign WIP, not part of this plan).

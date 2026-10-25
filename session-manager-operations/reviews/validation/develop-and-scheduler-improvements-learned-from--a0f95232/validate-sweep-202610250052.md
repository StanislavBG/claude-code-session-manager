# Validation sweep 202610250052

Base f22b2bc..HEAD (5b8ddf0e). Combined gate (all PRD gates, one run): 9 files, 134 tests passed.
Commits: ac164a76 (2205), f695cc50 (2206), 14c11623 (2207), 247bc10d (2208), e260def7 (2210). PRD files found in prds-archived/.

## create-prd-respond-before-reconcile — VERIFIED
- Bounded 2000 ms race, timer cleared, late rejection caught/logged: prdCreate.cjs:705-717.
- `applied:true` on success (:732) and alreadyExisted (:503); `applied:false` on every refusal (:268-677).
- Tests added in prdCreate.test.cjs (+28 lines); gate green.

## list-prds-ts-archive-and-cwd-normalize — VERIFIED
- One-level `<ts>/` descent: scheduler.cjs:~10388; `normalizeListCwd` (tilde/slash/worktree) at :10363, used at :10372 and filter :10691.
- listPrdsTsArchive.test.cjs (94 lines) + listPrdsCwdScoped green.

## get-prd-bare-slug-lookup — VERIFIED
- `resolveBareSlugFile` in prdPaths.cjs uses resolveDepSlug, scans live, archived and one `<ts>/` level; ambiguous returns error naming files; exact path unchanged.
- getPrdBareSlug.test.cjs green.

## create-prd-batch-primitive-and-route — VERIFIED
- createPrdBatch prdCreate.cjs:766; cap 40 (:755); DFS cycle detection; rollback unlinks written files (:~828); route `/admin/scheduler/create-prds` :926; `adminCreatePrds` ipcSchemas.cjs:457.
- prdCreateBatch.test.cjs green.

## prd-structured-patch-primitive — VERIFIED
- prdBodyPatch.cjs exports applyStructuredPrdPatch, pure, reuses prdGateFiles validate/render; prdBodyPatch.test.cjs green.

## Findings
- Minor: prdCreate.cjs batch rollback (~:828) removes files but NN allocation is not returned, so a failed batch leaves NN gaps (high-water stays consistent, not reused).
- Minor: diff also contains commit 681a3128 (runVerify.cjs) and PRD_AUTHORING.md, outside these five PRDs; not reviewed here beyond the test suite not regressing.
- Minor: /code-review and /security-review not run as separate agents; self-reviewed — new route reuses the create-prd auth path, gate/files validated by existing validators, bare-slug path built via safeSlugPathIn (no traversal).

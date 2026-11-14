# Validation: artifact-only shared declaration

Base: 41300c91 (known). Commits: 5108590b (helpers), f54904d6 (wire). Also in range: 52040ef2 (gitWorktree test, unrelated to this plan) and d0707f94 (a prior validation record).
Review tools: `/code-review` and `/security-review` were not run. I self-reviewed the diff instead (see Findings).

## prd-artifact-declaration-helpers (3121) — VERIFIED
- `isArtifactOnlyDeclaration` is at prdFrontmatter.cjs:128-142. It returns true only for a non-null object with `deliverable === 'artifact'` and a non-empty array `artifactPaths`. `parseInlineList` is unchanged (lines 115-126) and now exported (module.exports at the end of the file).
- False cases (null, undefined, missing or other deliverable, missing, empty or non-array paths) are covered in `prdFrontmatterArtifact.test.cjs` (47 lines, new).
- `parseArtifactPaths` (prdParser.cjs:~52) delegates to `parseInlineList`. A non-string gives null, an empty list gives null, and quotes are stripped by the shared parser.
- The `parsePrdRaw` JSDoc is directly above `parsePrdRaw`, and `parseArtifactPaths` keeps its own JSDoc (diff-confirmed).
- Gate 1 (4 test files): 4 files and 19 tests passed. Gate 2 `npm run typecheck`: exit 0.
- Existing tests are unchanged: the diff of `src/main/__tests__` and `tests` between Base and HEAD shows only the added `prdFrontmatterArtifact.test.cjs`.

## artifact-only-predicate-wire (3122) — VERIFIED
- runVerify.cjs:910 now reads `if (isArtifactOnlyDeclaration(fm))`, and the require at line 47 is updated.
- scheduler.cjs: `artifactOnly = isArtifactOnlyDeclaration(job)` in `applyOrphanOutcomeInner`; `isArtifactOnly = isArtifactOnlyDeclaration(fm)` in `executeJob`, with the try/catch and the `prdPath` guard kept; `artifactVerified: isArtifactOnlyDeclaration(row)` in the reaper. The now-unused local `artifactPaths` was removed. The comments name the shared function.
- The absence check for `deliverable === 'artifact` in scheduler.cjs and runVerify.cjs printed "clean".
- Gate 1 (6 named test files): 6 files and 88 tests passed. No test file in the range was edited, so they passed without edits. Gate 3 typecheck: exit 0.
- The behavior is equivalent. The old checks gave false for a null `fm`. The new predicate also gives false for null or non-object input, so no null-handling difference.

## Plan-specific checks
- Test-file diff between Base and HEAD: the only addition is `src/main/__tests__/prdFrontmatterArtifact.test.cjs`. `gitWorktree.test.cjs` is also modified by 52040ef2, which is not part of this plan and is not an artifact-only test.
- `timeout 600 npm run test:unit` (once): 1059 files passed, 10311 tests passed, 1 skipped, 0 failures. About 202 s. The stderr noise (PageShell orphan-hook error, canvas not implemented) is from expected-throw tests. Five `SM_*` vars were set in the env, and the run was green anyway.

## Findings
- Critical: none.
- Important: none.
- Minor: none specific to the plan. `parseInlineList(raw)` calls `raw.trim()` without a type check. `parseArtifactPaths` guards for strings, and the existing `parsePrdFile` callers pass strings, so it is safe.
- Security self-review: no new input handling, paths, or secrets. The change only consolidates predicates.
- Minor: 52040ef2 (gitWorktree test change) falls in the Base..HEAD range but belongs to another plan. It was not reviewed here.

# Validation: linear-landing fix wave (I-1, I-2)

Base: 9ff9935c2537bb59df38d524f3200a108eaac8aa. Commits: 0c72c8d3 (2830), af337c03 (2831), fda259f0 (2832). PRD files found in the Epic's prds-archived/. `/code-review` and `/security-review` were not run as skills; the 709-line diff was self-reviewed for correctness, input handling, path traversal and helper duplication.

## replay-refuses-lossy-merge-content — VERIFIED
- `replayBranchOnto` counts `rev-list --count --merges <onto>..<tipIn>`; if above 0 it compares `merge-tree --write-tree --no-messages <onto> <tipIn>` with the replayed tip's tree, and returns `branch_has_merges` on mismatch or no tree (gitWorktree.cjs:2458-2484). A range with no merges takes only the one extra rev-list.
- Both callers use `REPLAY_MERGE_FALLBACK_KINDS` (gitWorktree.cjs:1620, :2596, set at :2311), so the same `linearFallback` and warn line apply.
- scheduler-operations.md carries the `branch_has_merges` row. The gate's grep + `lint:docs` is green (ok, 21 junctions).
- Tests added in gitWorktree.test.cjs (+123 lines). Gate 1: 3 files, 167 passed. typecheck green.
- Independent I-1 repro (temp repo: b1, a branch merge of main adding `g` and editing a line, then main advanced):
  - `replayBranchOnto` → `ok:false, failureKind:branch_has_merges`.
  - `integrateOntoRef` → warn line, `mergeCommit:true, linearFallback:branch_has_merges`; the tree has `g`, and `f` = `1,2,THREE,4,5`.
  - `integrateJobBranch` → `mergeCommit:true, linearFallback:branch_has_merges`; HEAD has `g` and the hand edit. No content lost.

## branch-content-landed-check — VERIFIED
- `isBranchContentLanded` is exported (gitWorktree.cjs:1996, export at :3107). It resolves both names to SHAs first and a leading `-` is only tried via `refs/heads/`. It returns null when either name is unresolved; `--is-ancestor` gives true; `rev-list --right-only --cherry-pick --no-merges --count base...branch` = 0 gives true; `merge-tree` tree equal to `base^{tree}` gives true; every other outcome (conflict, git too old, error) gives false, and the whole function is wrapped so it never throws.
- New test file gitWorktreeContentLanded.test.cjs: 7 passed, covering null, ancestor, replay-landed (ancestry false), shifted context, unlanded and conflicting branches.
- typecheck green.

## wire-branch-content-landed — VERIFIED
- `isBranchAlreadyIntegrated` keeps the ancestry fast path, then awaits `isBranchContentLanded`. It still returns null for a missing branch, and its header comment says why (gitTreeGuard.cjs:515-570).
- `isBranchMergedIntoHead` uses ancestry, then the helper (gitWorktree.cjs:1966-1980).
- `attributeLandedCommits` (scheduler.cjs:9444-9457) adds `commitsReplayedFromBranch`: it matches author name, email, date and message against `git log -z --max-count=200 <sha>..<branch>`, accepts only hex shas, rejects branch names starting with `-`, and treats any git failure as no match.
- Tests: gitTreeGuardLinearLanded (new), branchSweep, scheduler-looks-done and scheduler-guard-verdict-autoresolve gate: 44 passed. typecheck green.

## Review focus
1. I-1 reproduction: see above. No content lost on either path.
2. Remaining ancestry-only checks (`grep merge-base|--is-ancestor` in src/main, non-test):
   - gitWorktree.cjs:1569, integrateBranch's "branch has no new commits" no-op detection. It misses a linearly landed surviving branch, so that branch is re-replayed (`replayed:0`, harmless). Not a landed verdict (see Minor M-1).
   - gitWorktree.cjs:1383, `isCarriedWipOnly`. It is unrelated, a diff base.
   - scheduler.cjs:9634 and :9659, gitTreeGuard.cjs:731 and runVerify.cjs:472 test `landedCommit` (a base-side SHA) against HEAD. This is correct as it stands.
   - scheduler.cjs:9448 is the intended ancestry half of attribution.
   - No sm-job/sm-epic landed-verdict check was missed.
3. Full `npm run test:unit` (SM_* unset): 949 files passed, 8974 tests passed, 1 skipped, exit 0. No red anywhere.

## Findings
### Critical
- none
### Important
- none
### Minor
- M-1 gitWorktree.cjs:1569: `integrateBranch`'s no-op check is ancestry-only, so a surviving linearly landed branch is replayed again each time. The replay skips patch-equivalent commits, so the result is harmless. Using `isBranchContentLanded` there would shortcut it.
- M-2 gitWorktree.cjs:2025-2034: proof 2 ignores merge commits (`--no-merges`, documented in the comment). A branch whose non-merge commits are patch-equivalent on base but whose merge commit holds extra content, such as an evil-merge file `g`, can read as landed. Not a regression: the old ancestry check was stricter, and `deleteBranchKeepingUniqueCommits` still pins the tip when the sweep retires it. A `--merges` count of 0 guard, or a fall-through to proof 3 when merges exist, would close it.
- M-3 `isBranchContentLanded` runs the full `merge-tree` on every unlanded check, within a 30s timeout. That is acceptable for the reaper and sweep paths.

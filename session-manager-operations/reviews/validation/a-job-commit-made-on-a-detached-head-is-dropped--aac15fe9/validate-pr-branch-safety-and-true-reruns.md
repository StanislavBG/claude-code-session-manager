# Validation: PR-branch safety and true re-runs (PRDs 2430–2437)

Base: ad36c05d. Commits: 9685abf6 (2430), 50921b5f (2431), aced06f1 (2432), 181ea4fb (2433), 96ba5a7d (2434), 3988fdae (2435), 0ebb6ff5 (2436), 766fde6e (2437). All eight PRD files found under `prds-archived/`.

Gates: every vitest gate file (13 files, 309 tests) re-run green. `npm run test:unit` (SM_* unset): 834 files pass, 3 fail — exactly the three Epic-216c3127 files (dev-plugin-skillset, webRemoteSessionCreate, SessionActionsBar). No other red.
Typecheck/lint were not re-run: they are not among the listed acceptance criteria beyond the unit suite, and the diff touches only .cjs plus markdown.

## reconcile-lands-only-the-runs-own-commits — VERIFIED
- `on-other-ref` returned when `countCommitsOnNoRef(finalHead)===0`, no writes: gitWorktree.cjs ~2453.
- Fast-forward only when branchTip is an ancestor AND `countRange(branchTip..finalHead)===unheld`; otherwise pin + `diverged`: gitWorktree.cjs ~2454-2458.
- `pinUnlandedWorktreeCommits` has no `baseBranch`; keeps a commit unless count is exactly 0 (-1 keeps); caller in scheduler.cjs finalizeJobWorktree updated.
- replay-verdicts.cjs passes `--exclude=${STRANDED_REF_PREFIX}*` before `--all`.
- Tests (gitWorktree.test.cjs 2108+) cover the PR-branch, detached-PR-tip, diverged-on-top and merge-commit cases; green.

## verifier-reachability-honors-pr-branches — VERIFIED
- `commitExistsInRepo` / `commitOnAnyRef` exported, bounded, never throw; git error in commitOnAnyRef → false (parks): runVerify.cjs 484-517.
- Filter drops unknown SHAs; `isMergeMainSlug` slugs use any-ref, others keep `isAncestorCommit`: runVerify.cjs ~815-820.
- runVerify tests green (real dangling commit).

## satisfied-proof-counts-from-prd-authoring — VERIFIED
- `issuedAtForPrd` never throws, returns string/null: prdDeclaredPaths.cjs 79-96.
- `findSatisfyingCommitOnMain` uses earliest valid of queuedAt/issuedAt, `[]` when neither valid: scheduler.cjs ~3533-3546.
- PRD_AUTHORING.md line 1 = v16, rule reads "since the PRD was written". Tests green.

## unchanged-carried-paths-primitive — VERIFIED
- gitWorktree.cjs 962-991: byte compare, absent-from-both returned, errors/out-of-root paths left out; exported and re-exported (jobWorktree.cjs). Tests green.

## commit-guard-judges-the-jobs-own-dirt — VERIFIED
- finalizeJobWorktree filters `unchangedCarriedPaths` after salvage, guarded by `typeof` check: scheduler.cjs ~5712-5717.
- `jobDirt` computed once and passed to commitGuardSkipped with `landedCommit: jobLandedCommitThisRun`: scheduler.cjs ~6310, ~6536.
- gitTreeGuard.cjs commitGuardSkipped: `clean` + worktree + dirt + no landedCommit → not skipped. Tests green.

## sweeps-keep-unique-branch-commits — VERIFIED
- `deleteBranchKeepingUniqueCommits` (gitWorktree.cjs ~2352) pins tip when unique or check fails, then `branch -D`; used at the three call sites.
- reconcileWorktreesOnBoot: key = `keyFromBranch || basename`; deletes branch only when `keyFromBranch` non-null.
- `listStrandedPins` filters by date and by no-ref-holds; re-exported. Tests green.

## reaper-reads-stranded-pins — VERIFIED
- scheduler.cjs ~8258-8280: listStrandedPins per dead row, sinceMs from startedAt (0 if unparseable), sets `run_commit_not_landed` ahead of the integrated branches. Tests green.

## investigation-relands-pinned-commit — VERIFIED
- scheduler.cjs ~5011-5030: note only for `run_commit_not_landed`, names the for-each-ref command, oldest-first cherry-pick, gate, re-implement only the rest; failure-log fallback stated. Test + doc row present.

## Scratch-repo reproduction — VERIFIED
Real jobWorktree helpers in a temp repo (SM_WORKTREE_ROOT sandboxed):
- Worktree moved to PR branch `pr/x` with a commit: `reconcileWorktreeHead` → `on-other-ref`; after `integrateJobBranch`, file `p` absent from master.
- Detached HEAD commit with no other ref: → `fast-forwarded`; file `b` present on master.

## Findings

### Critical
- none

### Important
- none

### Minor
1. scheduler.cjs ~3536: the `issuedAt` window widens "satisfied on main" proof. A `pass_no_commit` is satisfied when every Files path was touched by any commit since the PRD was written; sibling PRDs in the same plan that edit shared files (e.g. gitWorktree.cjs across 2430/2433/2435) can now supply that proof. This is the mandated design and bounded to `pass_no_commit`, but it is weaker than path-and-content proof.
2. gitWorktree.cjs ~2507 `pinStrandedHead`: a boot sweep of a dead detached checkout pins only the current HEAD. Earlier reflog-only commits in that checkout are not pinned (finalize-time `pinUnlandedWorktreeCommits` covers the normal path; only a crashed run loses them).
3. gitWorktree.cjs ~962 `unchangedCarriedPaths`: `readFile` follows symlinks inside cwd/dir; read-only comparison, so no write or disclosure path, noted only.
4. Reaper path: an `on-other-ref` worktree whose branch sits at the fork point is not specially handled in the reaper's `integrated` branches; it relies on existing no-commit proof. Nothing is landed, so safe.

No path found that lands a commit the run did not make, or deletes a worktree/branch holding a commit no ref reaches: every deletion site (removeWorktreeDir, deleteBranchKeepingUniqueCommits) pins first, and boot sweep no longer deletes non-owned branches.

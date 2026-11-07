# Validation: linear-landing plan

Base `2a56c643` (HEAD `9b563a4e`). The 274x PRDs landed before Base and were reviewed at their commits (948297b1, fce47f17, 0e2707fa) and at HEAD.
Gates re-run at HEAD with SM_* env unset: `vitest run gitWorktree.test.cjs gitWorktreeStrayRefLanding.test.cjs gitWorktreeIntegrateSha.test.cjs` → 3 files, 162 tests passed; `npm run typecheck` exit 0; `npm run lint:docs` ok; the four docs greps ok; `node --check epicWorktreeMerge.cjs` ok; CLAUDE.md 11983 chars (under 12000).
`/code-review` and `/security-review` were not run as separate tools; I self-reviewed the diff (no secrets, SHA-only args to git, no path handling added).

## 2741-linear-replay-primitive — VERIFIED
- Exported and implemented: `gitWorktree.cjs:2243` `replayBranchOnto`. Ancestor case returns `fastForward:true, replayed:[], skipped:[]` (:2257-2259).
- Diverged: `rev-list --no-merges --cherry-pick --right-only` (:2268-2276); skipped = all minus kept (:2278); >200 refused (:2280); per-commit merge-tree with `--merge-base=<C^1>` (:2297); author name/email/date and full message kept through `commit-tree` env (:2340-2344); conflict → `content_conflict` with paths; 129 → `git_too_old`; whole body in try/catch (never throws).
- Tests: 10 `[replay]` tests incl. the `-`-prefixed branch name (test.cjs:2667); all green.

## 2742-linear-replay-pure-addition-resolve — VERIFIED
- `resolvePureAdditionInTree` is called from the conflict branch (gitWorktree.cjs:~2316); sets `autoResolved:'pure_addition_concat'` + `resolvedPaths` (:2370).
- Tests `[replay] pure-addition ...` at test.cjs:2613, 2627, 2640, 2647 cover the concat, non-addition/non-allowlisted extension, and `SM_PURE_ADDITION_MERGE_DISABLE=1`; all green. integrateBranch's own auto-resolve tests still pass (whole file green).

## 2743-linear-landing-in-checkout — VERIFIED
- Default env returns `{ok, integrated, linear:true, sha, replayedCommits}` with no `mergeCommit` (gitWorktree.cjs:1623-1626); landing is `merge --ff-only --no-overwrite-ignore <tip>` in a 3-attempt loop that replays again when HEAD moved (:1614-1670).
- Fallback (`--no-ff`, message unchanged) only on `disabled` / `git_too_old` / `content_conflict` / exhausted `ref_race`, with one `console.warn` and `linearFallback` (:1675-1676). Blocked-ff handling reuses `parseBlockingMergePaths`/`filterIgnoredPaths`/`pathsIdenticalToBranch` against the replayed tip (:1640-1665).
- Tests `[linear] ...` (test.cjs:190-282) pass; the byte-for-byte message test runs with SM_LINEAR_LANDING_DISABLE=1 (:1257 etc.). The scheduler.cjs log-line change was not re-diffed (it predates Base); not otherwise checked.

## linear-landing-onto-ref (PRD 2825, commit 1c44ff83) — VERIFIED
- `attemptIntegrateOntoRef` (gitWorktree.cjs:2460-2479): replay with `branchSha`, CAS via `updateRefOrClassify([targetRef, r.tipSha, oldSha])`, returns `linear:true, replayedCommits` (+ `autoResolved`, `resolvedPaths`), no `mergeCommit`. Other replay failures → `{ok:false, failureKind:'other'}` without touching the ref; CAS loss → `{retry:true}`.
- Merge fallback (:2479-2506) only for `disabled`/`git_too_old`/`content_conflict`, preceded by a warn naming branch and ref; result carries `linearFallback`.
- Comments updated (:2230-2236, :2378-2388, :2632-2636).
- Tests: the old merge-commit test is replaced by a linear one; new tests for disabled (test.cjs:1873) and the conflict-on-replay/clean-net fallback; the stray-ref test is rewritten with an added SM_LINEAR_LANDING_DISABLE test. All green.

## linear-landing-docs (PRD 2826, commit 9b563a4e) — VERIFIED
- scheduler-operations.md §5a added between §5 and §6; covers both paths in the required order, callers, the fallback table with each `linearFallback` and warn line, the non-merge-only note and the consumer check. I checked every statement against gitWorktree.cjs (see Finding I-1 for one gap).
- domain-model.md worktree bullet now reads ff-only → linear replay → merge-commit fallback → abort-and-flag with a link to §5a. epicWorktreeMerge.cjs diff is comment-only; `node --check` passes. lint:docs ok.

## Review focus answers
1. **Two-parent commits, default env.** Every merge-writing site is inside the logged fallback: `merge --no-ff` at gitWorktree.cjs:1678, the blocked-ff retry at :1707 and the concat-resolve `git commit` at :1740 (all after the warn at :1675), and the onto-ref `commit-tree -p -p` at :2484 (after the warn at :2479). `replayBranchOnto`'s `commit-tree` (:2343) and scheduler.cjs:4377 (salvage) have one parent. No `merge` call exists in scheduler.cjs. No undocumented merge path found. The only way a merge reaches base outside the fallback is a merge commit already in the branch carried by a fast-forward (documented).
2. **Linear landing read as unlanded.** Happy path is fine: `landedCommit` is stamped from main HEAD after integration (scheduler.cjs:8748-8757, :4230) and the job branch is deleted by cleanup. But see I-2.
3. **Merge commit inside a branch.** Yes, content can differ silently; see I-1 (reproduced).
4. **Docs vs code.** Matches, except the gap in I-1.

## Findings

### Critical
- none

### Important
- **I-1 — replay silently drops the content of a merge commit inside the branch.** `replayBranchOnto` lists commits with `--no-merges` (gitWorktree.cjs:2268-2270) and never compares the result to the branch tip's tree. I reproduced it in a temp repo: branch `br` = `b1` + a merge of main into `br` with an evil resolution (an extra file `g` and a hand-edited line), then main advanced. `integrateBranch` returned `{linear:true, replayedCommits:1}`; main got only `b1`, and `g` and the hand edit were gone. No fallback, no warn. This is the exact "conflict resolved with `git merge` in an Epic worktree" case (the EpicDetail banner tells the human to do this). §5a only documents the fast-forward case for merge commits. Suggested fix, not done here: in `replayBranchOnto`, return a distinct fallback kind (or a tree-equality check against the expected result) when `rev-list --merges <onto>..<tip>` is non-empty, and document it in §5a.
- **I-2 — ancestry-based "landed" checks misread a linearly landed branch that still exists.** `isBranchAlreadyIntegrated` (gitTreeGuard.cjs:539-558) and `isBranchMergedIntoHead` (gitWorktree.cjs:1958-1966) test `merge-base HEAD branch == branch tip`, and `attributeLandedCommits` uses `--is-ancestor sha branch` (scheduler.cjs:9443). After a replay the original branch commits are not ancestors of base, so a surviving `sm-job/*` branch (cleanup failed, or a branch left by a crash) reads as unmerged: the reaper parks with "never merged" (scheduler.cjs:8761), and the branch sweep re-runs integrate on it each process lifetime (harmless, since the replay skips patch-equivalent commits and returns `replayed: 0`, but the branch is never retired). Latent in the happy path (the branch is deleted), but nothing was updated for it and no test covers it. Not exercised here.

### Minor
- M-1 — gitWorktree.cjs:1601 first ff attempt passes the branch name, not a SHA (pre-existing; `branchHead` is used elsewhere).
- M-2 — `/code-review` and `/security-review` skills were not invoked; the diff was reviewed by hand.

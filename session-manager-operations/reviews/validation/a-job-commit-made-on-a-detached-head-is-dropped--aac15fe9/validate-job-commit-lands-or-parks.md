# Validation: job commit lands or parks (base e4163106)

Base known (`Base: e4163106`). Plan commits b6e94e1c..2c572436 (2408–2415). PRD files found under `prds-archived/`.

## Per-PRD verdicts

All eight per-PRD gate sets re-run together: 23 test files / 413 tests green, `npm run typecheck` green, `npm run lint` green.

- **reconcile-worktree-head-primitive — VERIFIED.** `reconcileWorktreeHead`, `pinUnlandedWorktreeCommits`, `resolveDefaultBranch` re-exported at jobWorktree.cjs:63-65. `pinStrandedHead` called first in `removeWorktreeDir` (gitWorktree.cjs:332) and `teardownOrphanedCheckout` (:412). Real-git tests in gitWorktree.test.cjs pass.
- **finalize-lands-or-parks-off-branch-commits — VERIFIED.** `run_commit_not_landed` appears in none of `MECHANICALLY_RESOLVABLE_VERDICTS` (reviewLadder.cjs:94), `RESCANNABLE_VERDICTS` (:171) or `GUARD_VERDICT_EVIDENCE_ELIGIBLE` (:326). The three attribution/cancel/committed-in-window specs pass.
- **landed-proof-uses-files-and-base-branch — VERIFIED.** Specs for prdDeclaredPaths, landedSinceRun, already-satisfied-on-main and looks-done pass (master-default repo and pinned-exclusion cases included).
- **verifier-stops-trusting-tracked-paths — VERIFIED.** `grep` in runVerify.cjs finds only a historical-verdict comment (:32); `extractPrdDeliverablePaths` and `allDeliverablesAlreadyTracked` are gone. `pass_no_commit` is in `NO_ATTRIBUTABLE_COMMIT_VERDICTS` (reviewLadder.cjs:495). Scratch burrow repro below.
- **commit-guard-skip-decision — VERIFIED.** scheduler-commit-guard-noop and already-satisfied specs pass.
- **reaper-and-epic-merge-reconcile-head — VERIFIED.** reap-dead-running-jobs and epicWorktreeMerge specs pass.
- **run-commit-not-landed-labels — VERIFIED.** rcaReport, reviewNotice and sched-primitives specs pass.
- **declared-no-commit-prds-and-ops-doc — VERIFIED.** scheduler-mcp-server.cjs:203-210 lists `deliverable` and `artifactPaths`. PRD_AUTHORING.md line 1 reads v15. scheduler-operations.md:253 has the `run_commit_not_landed` row (`git for-each-ref refs/sm-stranded`, cherry-pick) and calls `pass_no_commit_already_shipped` historical.

## Burrow reproduction (scratch master-default repo, real jobWorktree helpers)

- Commit made after `git checkout -q HEAD~0` + `git commit -q`: `reconcileWorktreeHead` → `fast-forwarded`; `integrateJobBranch` → `integrated:true`; the SHA sits on `refs/heads/master`. It lands.
- Commit made on detached HEAD, then HEAD returned to the branch: `pinUnlandedWorktreeCommits` returned the SHA pinned at `refs/sm-stranded/<slug>/<sha>`, and the branch was kept (`keepBranch:true`). It parks, naming the SHA.

## Full suite

`timeout 300 npm run test:unit`: 833 files passed, 3 failed (7883 tests passed, 3 failed). The three failures are outside this plan's diff and come from the macro `autoStartTargets` / send-feedback commits (e39ad863..678e1979) landed in the same base..HEAD range:
- scripts/__tests__/dev-plugin-skillset.test.cjs: plugin.json version ≠ marketplace entry.
- tests/unit/webRemoteSessionCreate.spec.ts: "macro without inputs forwards the default lines".
- SessionActionsBar.test.tsx: "New Macro -> fill -> Save" (expects the old `macros.save` payload).

So the combined-suite criterion is **not green**. None of the failures touches a verdict-name or stub-shape contract of this plan.

## Findings

### Critical
- none

### Important
- Full `test:unit` is red (3 failures, above) from the unrelated macro-autostart plan. It needs a fix wave, and the plan's own changes are not implicated.
- Branch deletion that can still drop commits no ref reaches. `pinStrandedHead` pins only the checkout's HEAD, and only when HEAD is unreachable from any branch. These `git branch -D` sites delete a branch tip that may hold unintegrated commits, with no pin:
  - gitWorktree.cjs:877 (leftover same-slug branch on re-create)
  - :1790 (ops-only-dirty reclaim)
  - :1858 (expired-worktree sweep)
  - The `keepBranch:false` path at :1534 is only reached after integration.

  If a worktree was HEAD-on-branch with unique commits, nothing pins them. This is pre-existing and outside the burrow detached-HEAD case, but it is the same class: a worktree or branch removed while a commit is reachable from no other ref.

### Minor
- `pinUnlandedWorktreeCommits` reads at most 200 reflog entries and pins at most 20 (gitWorktree.cjs); a very long run could leave older stranded commits unpinned.

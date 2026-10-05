# Validation: sentinel-fail and commit attribution

Base: `ada0c082` (as given in the PRD). Commits in range: `8ff5e16e` (1539), `4f401df6` (1541), `79412477` (1543), `a6b33ff7` (1545).
Gates were run per file with a scratch TMPDIR. The worktree had no `node_modules`, so I temporarily symlinked the main checkout's (gitignored) and removed it afterwards.

## 1539 sentinel-fail-never-clean — VERIFIED
- `src/main/runVerify.cjs:1107-1119`: right after `scanSentinel`, `sentinel === 'fail'` returns `conclude('sentinel_fail', 'executor reported SCHEDULER_VERDICT: FAIL: <reason>', 'needs_review', …)`. It is an early return, so no later override (PASS+commit, groundTruth demotion, allowPreSentinelHeal) can apply. It is independent of `commitEvidence`.
- `scanSentinelReason` (`runVerify.cjs:555-575`) trims the text and caps it at 300 chars. It is exported.
- Transcript issues are kept as `annotations`.
- `rcaReport.cjs:53` and `sched-primitives.tsx:255` both have the `sentinel_fail` label.
- `grep` of `terminalRunOutcome.cjs` and `gateAuthority.cjs` finds no `sentinel_fail`. `RESCANNABLE_VERDICTS` (`scheduler.cjs:10506`) lacks it too.
- The test file `runVerify-sentinel-fail.test.cjs` exists. Gate: `runVerify-sentinel-fail`, `runVerify`, `runVerify-landed-commit-outranks`, `runVerify-blocked-by-foreign-wip` → 4 files, 75 tests passed.

## 1541 integrate-branch-returns-landed-sha — VERIFIED
- `gitWorktree.cjs:1425-1427`: the ff return has `sha: tryResolveCommit(cwd, branch^{commit})`, read from the branch ref.
- `:1434`: the `--no-ff` return has `sha: readHeadSha(cwd)`, read right after the merge.
- `:1457` (identical-duplicates auto-resolve) and `:1485` (`pure_addition_concat`) also carry `sha`.
- The no-new-commits and carried-wip-only returns were untouched, and failure returns are unchanged.
- `gitWorktreeIntegrateSha.test.cjs` exists (79 lines). Gate with `gitWorktreeStrayRefLanding.test.cjs` → 2 files, 15 tests passed.

## 1543 worktree-landed-commit-from-own-integration — VERIFIED
- `finalizeJobWorktree` returns `integratedSha` (`scheduler.cjs:7297`, `:7322`, `:7344`). `spawnJob` destructures it in the `finally` block (`:7772`).
- `resolveRunCommitAttribution` (`:855`) is exported (`:13683`). For worktree runs it returns `landedCommit = integratedSha || null` and `committedDuringRun = Boolean(landedCommit)`.
- `spawnJob` skips `computeCommittedDuringRun` for worktree runs (`:7926`) and uses the helper (`:7957`).
- The commit guard uses `worktree.ok ? Boolean(jobLandedCommitThisRun) : <HEAD compare>` (`:8041`).
- Gate: `scheduler-landed-commit-attribution`, `scheduler-integration-failure-stamp`, `runVerify-transcript-commit-evidence` → 3 files, 17 tests passed. `runVerify-landed-commit-outranks` is covered in the 1539 gate and passes.

## 1545 inplace-landed-commit-transcript-proven — VERIFIED
- `parseLog` returns a deduplicated `transcriptCommitShas` (`runVerify.cjs:178`, `:198-199`, `:251`). The `transcriptCommitLanded` logic is unchanged.
- The helper's in-place branch (`scheduler.cjs:866-880`) takes `rangeCommits`, `transcriptCommitShas` and `siblingOverlap`. It credits the first (newest) range commit that starts with a transcript sha, otherwise null. The legacy HEAD-delta/window path applies only when there are no transcript shas and no sibling overlap.
- `gitRangeCommits` (`:884`) uses `execFile` with a 10s timeout and returns `[]` on error. `spawnJob` computes it for in-place runs only (`:7937-7952`) and reads shas via `parseLog`.
- The `siblingOverlap` computation covers same cwd, other slug, status `running`, or a time-window overlap.
- The tests cover the three in-place cases. `runVerify-sentinel-fail.test.cjs:103` asserts sha extraction.
- Gate: all 1545 test files were covered by the runs above. Typecheck exited 0 (`tsc --noEmit` for both configs, no errors).

## Replay check — PASS
I ran `verifyRun` against a copy of the 2026-10-04T21-26-30-476Z log for job `50-evolet-v2-deploy`, with `committedDuringRun=true` and `jobLandedCommitThisRun='dea49a58'`. It returned:
`verdict: sentinel_fail`, `downgradeTo: needs_review`, reason `executor reported SCHEDULER_VERDICT: FAIL: school_events._norm doesn't fold curly apostrophes…`. It was previously `clean`.

## Findings
### Critical
- none
### Important
- none
### Minor
- `scheduler.cjs:7940` and `:8152`: `spawnJob` parses the full run log twice on the in-place path (once for shas, once for the sentinel scan). The log is read on the exit-0 path anyway, so this is only wasted work; the second parse could be reused.
- `scheduler.cjs:7943-7951`: `siblingOverlap` treats any same-cwd job whose window overlaps as a sibling, with `myEnd = Date.now()`. This is conservative: it can only turn credit off, never wrongly grant it.
- In-place runs where the transcript shows no sha, a sibling overlapped, and the job really did commit via a path the harness doesn't report as `gitOperation` now get `landedCommit` null. That is the intended trade-off per the PRD.
- Security / self-review: no new path-building from untrusted input; `git rev-list` is called via `execFile` argv with a fixed shape and no shell; no secrets. The untracked 0-byte `<path>` file in the tree is the known sqlite MCP placeholder, not from this plan.

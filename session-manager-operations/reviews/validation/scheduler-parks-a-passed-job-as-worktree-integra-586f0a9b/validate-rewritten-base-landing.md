# Validation: rewritten-base landing plan (2901–2906, 2908–2911)

Base: 1023a05fcf6709f8c926ff21484bc8950c9d4b0c; HEAD 40127d4f. Diff: 22 files, +1651/-98.
All 10 PRDs sit in prds-archived/. Each PRD's gate was re-run in the foreground with SM_* env unset.
- Git gates (13 files, all PRDs' git specs combined): 229 passed.
- Scheduler gates (12 files): 185 passed.
- `npm run typecheck`: exit 0.
- Full `npm run test:unit`: 979 files / 9411 passed, 1 skipped, 0 failed. No spec outside the gates was broken.
- /code-review and /security-review were not run as separate skills; the diff was self-reviewed instead (see Findings).

## fork-bounded-replay — VERIFIED
- Fork-bounded replay and the merge-tree path with `--merge-base=<sinceSha>` are covered by gitWorktreeForkBoundedReplay.test.cjs, which passed. Its recipe reproduces the content_conflict without sinceSha and the clean replay with it.
- `isBranchContentLanded` takes `sinceSha` (gitTreeGuard.cjs:521-560 consumes it).
- The existing suites (gitWorktree, ContentLanded, LinearLanded, branchSweep) pass unchanged.

## worktree-fork-sha — VERIFIED
- `createWorktree` resolves the fork SHA (gitWorktree.cjs:973), uses it as the start point (:995) and returns it as `forkSha` (:1039), omitted when absent.
- `resolveForkSha` is at :3345. It reads `refs/heads/<branch>` only, so a '-'-prefixed name is safe. It validates `recorded` as an ancestor of the tip, falls back to the oldest reflog entry, and never throws.
- gitWorktreeForkSha.test.cjs passes.

## integrate-rewritten-base — VERIFIED
- `forkSha` is threaded through integrateBranch (:1567), the ref path (:1625/:1657) and attemptIntegrateOntoRef (:2889).
- `resolveRewrittenFork` (:2250) defines "base rewritten". The merge fallback is suppressed when `baseRewritten` (:1766, :2946).
- A failed replay returns `baseRewritten: true` with conflictedPaths (:1832).
- integrateRewrittenBase.test.cjs passes, as do the IntegrateSha and IgnoredLiveFiles suites.

## scheduler-threads-fork-sha — VERIFIED
- spawnJob stores or deletes `worktreeForkSha` (scheduler.cjs:6620-6628).
- finalize passes `forkSha` (:6168).
- reviewLadder.cjs:125 returns `forkSha`; mechanical recovery resolves it (scheduler.cjs:4286).
- `stampIntegrationFailure` sets or deletes `integrationBaseRewritten` (:4236).
- scheduler-fork-sha-finalize.test.cjs passes; the recovery, stamp and resume suites pass.

## reaper-lands-pass-runs — VERIFIED
- The reaper resolves `forkSha` (scheduler.cjs:8861) and passes it to `isBranchAlreadyIntegrated` (gitTreeGuard.cjs:545).
- On the run's own PASS line it calls `integrateJobBranch` (:8985-9000).
- On success it sets landedCommit and notLandedInfo null, then calls `cleanupJobWorktree`.
- On failure it sets `worktree_integration_failed` using `worktreeIntegrationVerdict`, and `stampIntegrationFailure` is called at :9204.
- A non-PASS run keeps the `reaped_without_integration` park.
- scheduler-reap-lands-pass-run.test.cjs passes (a, b and c cases).

## unlanded-commit-wording — VERIFIED
- runVerify.cjs:829-830 has the new wording, with the "is on no ref" variant for merge-main slugs.
- The `scheduleJobTransitions.cjs` comment is updated.
- The scheduler-operations.md diff adds the `worktree_integration_failed` (`integrationBaseRewritten`) and `reaped_without_integration` rows with the required statements.
- The reap tests are retitled with "no PASS line" (test.cjs:443, 493).
- The runVerify-transcript-commit-evidence, runVerify and reap-dead-running-jobs specs pass.

## boot-sweep-keeps-adopted-checkouts — VERIFIED
- `buildJobWorktreeIsLive` accepts `adoptedSlugs` (jobWorktreeBootLive.cjs:39-40).
- jobWorktreeBootLive.test.cjs, scheduler-boot-keeps-adopted-checkout.test.cjs and scheduler-boot-orphans.test.cjs pass.
- The init() reordering (partitionBootOrphans before the sweep) is exercised by the composition test; init() itself was not read line by line.

## branch-sweeps-fork-aware — VERIFIED
- branchSweep.cjs:97-123 resolves `forkSha` per branch and passes it to `isBranchMergedIntoHead` and `integrateJobBranch`.
- gitWorktree.cjs:2450 does the same for `reclaimTerminalJobOrphans`.
- The new branchSweep cases (rewrite, reset-without-rebase) pass.

## serialize-checkout-integration — VERIFIED
- `withCheckoutLock` is at gitWorktree.cjs:835, keyed by realpath. integrateBranch calls it through `module.exports` (:1689), which makes it spy-able, and the ref path takes no lock.
- checkoutLock.test.cjs passes.

## rewritten-base-carried-wip — VERIFIED
- `isCarriedWipOnly` takes `scopeBase` (:1479); integrateBranch passes the fork (:1733).
- The JSDoc for SM_LINEAR_LANDING_DISABLE is at :1562 and :2865.
- integrateRewrittenBaseCarriedWip.test.cjs passes.

## Findings
- Critical: none.
- Important: none.
- Minor:
  - Neither /code-review nor /security-review was run as a skill; only a manual review of the changed regions.
  - The git commands use argv arrays, `refs/heads/` prefixes and SHA regex validation, so no injection or path-traversal issue was seen.
  - gitWorktree.cjs grew by about 400 lines (integrateBranchInCheckout split plus ref-path rewrite). The duplicated rewritten-base logic between :1740-1840 and :2889-2960 could be shared later.

# Validation: projects-scan-bust-keeps-per-dir-cache + prd-recheck-uses-deep-cwd-bust

Base: 24f3e58e. Plan commits: b0578bc3 (PRD 2260), 54c4b9b0 (PRD 2261, merged f2b603e0). Commit 2e55f1a1 (remote-machines UI removal) is unrelated to this plan. Both PRD files found in `prds-archived/`.

## projects-scan-bust-keeps-per-dir-cache — VERIFIED
- bust keeps cache: `src/main/lib/activeSessions.cjs:118-125` sets `dirMtimeMs=NaN`, `cachedAt=0` per entry and `forceDeep` when `deep`. It never calls `rawScanCache.clear()` or `classifyMemo.clear()`.
- deep re-stats known dirs: `activeSessions.cjs:290-298` uses `deep = cached.forceDeep` and calls `scanOneProjectDirSync(path, known)` for known slugs. That function skips the tail read when the newest file is unchanged. The new `rawScanCache.set` at line 311 builds a fresh entry without `forceDeep`, so the flag clears after the pass.
- `__resetProjectCwdCacheForTests` is defined at `activeSessions.cjs:127` and exported at line 548. The `activeSessions-single-scan.test.cjs` diff is 16 lines (the isolation swap).
- New tests are in `activeSessions-incremental-scan.test.cjs` at lines 105 (default bust: 0 reads, +1 dir = 1), 128 (deep bust: 1 read) and 152 (classify memo survives).
- Gate: the full unit run (below) shows all four gate files green. Only `scheduler-reap-dead-running-jobs.test.cjs` failed.

## prd-recheck-uses-deep-cwd-bust — VERIFIED
- `src/main/scheduler.cjs:547` calls `bustProjectCwdCache({ deep: true })` inside try/catch.
- `src/main/lib/scheduler/queueStore.cjs:226` still calls `bustProjectCwdCache()` with no options. The comment at lines 217-224 now says the bust is shallow and why that is enough.
- The only non-test callers are scheduler.cjs:547 (deep) and queueStore.cjs:226 (shallow), by grep over `src`.
- Gate: the gate files (scheduler-prd-missing-skip, scheduler-verify-prd-path, scheduler-reconcile, lib/scheduler/__tests__) passed in the full run.

## Full unit suite (all SM_* unset)
`timeout 600 npm run test:unit`: 812 files passed, 1 failed. 15 tests failed, 7631 passed.
- RED: `src/main/__tests__/scheduler-reap-dead-running-jobs.test.cjs` (15 of 18 tests).
- At Base 24f3e58e (clean detached worktree, node_modules symlinked): 18/18 pass.
- At plan HEAD f2b603e0 in the same clean worktree: 15 fail. The failure is **plan-caused**, not pre-existing and not a worktree-location artifact.
- Pre-existing reds: none.
- Cause: the spec's `registerActiveProject` (line 50-55) rewrites `transcript.jsonl` inside the SAME slug dir (`fake-project-slug`) with a new cwd each test, then calls `bustCwdCache()`. Before the plan, bust fully cleared the cache. Now it is shallow, so the known dir is reused, the new cwd is never seen, and the rows stay `running`.

## Findings
### Important
1. `src/main/__tests__/scheduler-reap-dead-running-jobs.test.cjs:50-55` (and its `bustCwdCache` import at line 47): the shallow bust broke this spec's fixture. Fix: have the fixture call `bustProjectCwdCache({deep:true})` or `__resetProjectCwdCacheForTests()`, or write each project to a distinct slug dir. Neither PRD's gate included this spec, which is why it was missed. It is the scoped-gates-hide-contract-breaks pattern.
2. Behavioral note, `queueStore.cjs:226`: a shallow bust no longer re-reads a known dir whose newest transcript changed cwd. The async refresh should cover that in production. Only the test fixture depends on it. Confirm that is acceptable.
### Minor
- None.

Code and security review: self-reviewed. No new input handling, paths or secrets. The diff only adds in-memory cache flags.

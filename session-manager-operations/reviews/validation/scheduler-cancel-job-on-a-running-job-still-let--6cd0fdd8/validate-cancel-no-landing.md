# Validation: cancel-no-landing plan (2061, 2062)

Base: 023e442c9b08351d33c101e5b710bd7de14c4023. PRD files read from `prds-archived/`.
Commits: 8834d5fa (2061), 8cb301d9 (2062), plus earlier plan commits in range (cancel-job-durable-marker).

## 2061-cancel-running-job-never-lands — VERIFIED

- cancelJob stamps `j.cancelledRunId = job.runId ?? null` (when wasRunning) in the mutate; `killOrphanClaudePid(pid)` moved to after the mutate (src/main/scheduler.cjs ~10925-10927; early kill block removed).
- `isRunCancelled(slug, runId)` at scheduler.cjs ~5621: readQueue, requires truthy cancelledAt and `(cancelledRunId ?? null) === (runId ?? null)`; catch → false.
- finalizeJobWorktree takes `runId = null`, `deps.isRunCancelled`; before `integrateJobBranch` (~5575) emits `job_cancel_integration_skipped`, calls cleanupJobWorktree keepBranch:true, returns `cancelled: true`, `integratedSha: null`; final return has `cancelled: false`. spawnJob passes `runId` (~6059).
- resetJobFields deletes cancelledAt/cancelledRunId (~2681).
- Test file scheduler-cancel-no-landing.test.cjs exists (cancel test + control test).
- Gate: `vitest run` of cancel-no-landing, landed-commit-attribution, finalize-dispatch-guards, prdAdminRoutes → pass; `npm run typecheck` → exit 0.

## 2062-cancel-result-reports-job-branch — VERIFIED

- cancelJob result adds `landed`, `landedCommit`, `jobBranch`, `jobBranchSha` only when wasRunning (~10937-10957); pending path unchanged.
- jobBranchSha via `execGitAt(resolveProjectRoot(job.cwd || DEFAULT_PROJECT_CWD), ['rev-parse','--verify','--quiet','refs/heads/<branchNameFor(slug)>'], {timeout:10_000})`; try/catch → nulls.
- mcpToolCatalog.cjs scheduler_cancel_job `purpose` states commits never land, stay on job branch, reported as landed:false + jobBranch/jobBranchSha.
- Test extended (landed/jobBranch/jobBranchSha asserts; pending-row test asserts no `jobBranchSha` key).
- Gate: cancel-no-landing, prdAdminRoutes, mcpToolCatalog-pause → pass (5 files / 58 tests total with 2061 gate files); typecheck exit 0.

## Extra check: no other integration path for a cancelled run

`integrateJobBranch` call sites in scheduler.cjs: (1) finalizeJobWorktree (guarded by isRunCancelled), (2) performMechanicalRecovery (~3876). Recovery targets come only from `selectMechanicalRecoveryTarget`, which requires `status === 'needs_review'` (reviewLadder.cjs:108); cancelJob sets the row to 'failed' and refuses needs_review rows, and automated selectors skip rows with `isCancelledJob`. A cancelled row does not qualify.

## Findings

Critical: none.
Important: none.
Minor:
- Known, documented residual: a cancel arriving after `integrateJobBranch` finished cannot un-land the commit; result reports landed:false, jobBranch:null (scheduler.cjs ~5621, ~10938).
- cancelJob result also includes `cancelledAt` (from the earlier durable-marker PRD), not listed in 2062's criteria; harmless.
- Review was a self-review of the diff (no injection/path-traversal surface: branch name derived via branchNameFor(slug), git invoked with an argv array).

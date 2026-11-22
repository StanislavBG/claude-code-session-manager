# Validation — scheduler stall fix (1047/1056 cancelled-row dependency freeze)

Base: 50dce25d3201d6db252f2c3e9d89f254e3c0d104 (from the PRD's implementation notes). 45 files changed, +4674/−234 in `git diff <base>..HEAD --stat`.
All 13 PRD files found under `prds-archived/`. Every PRD's gate was re-run in one foreground vitest invocation (18 files):
`Test Files 18 passed (18) · Tests 216 passed (216)`.
`/code-review` and `/security-review` were not run as separate commands; I self-reviewed instead (see Findings).

## Prevented by construction

The 1047/1056 stall (a cancelled `1056-sm-contract-client` in Epic B froze 16 dependents of the completed `1047-sm-contract-client` in Epic A) cannot recur by these four routes. Each has a proving test:

| Cause | Guard | Proving test |
| --- | --- | --- |
| A same-name cancelled row takes over a dependency | 3487: `makeDepResolver` (`src/main/lib/prd/depSlugResolve.cjs:138`) tries an exact live row, then an exact satisfied slug, before any bare-name fallback. Cancelled rows (`isCancelledRow`, :94) are dropped from the bare fallback when a satisfied record shares the name. | `schedulerBatchDepends.test.cjs:321` "1047/1056: a cancelled same-bare-name row in another Epic does not block deps of a completed, archived PRD" — pickForProject batch contains 1048 and 1050. |
| Deps stored as bare slugs, or planId leaking across Epics | 3489: `resolveDependsOnToFullSlugs` (`prdCreate.cjs:257`) stores full NN slugs, preferring the same Epic. planId inheritance is scoped to the own Epic. | `prdCreate-dep-full-slugs.test.cjs:53` (bare sibling stored as the allocated NN slug even over an existing same-name PRD), `:82` (cross-Epic bare match warns, planId not inherited), `:107`, `:119`. |
| The cross-Epic duplicate PRD exists at all | 3497: `findCrossEpicDuplicates` (`prdCreate.cjs:290`) refuses the create, naming slug, Epic and status. `allowDuplicateOf` is the explicit, audited override. | `prdCreate-cross-epic-duplicate.test.cjs:66` "1047/1056 sequence: the second Epic's create is refused…", plus `:84` (archived rows count), `:130` (batch all-or-nothing, 409). |
| A cancel or dismiss strands dependents | 3499: `cancelJob` refuses with pending dependents unless a cascade/repoint/clear choice is passed (`scheduler/cancelDependents.cjs`). 3492: `dismissCancelled` (`queueOps.cjs:588`) applies the same rule, and a dismissed PRD goes to `prds-cancelled/`, which is never read as satisfied. | `cancel-job-dependents.test.cjs:105` (refuses, nothing changes), `:120` cascade, `:136` repoint, `:166` clear. `cancelled-row-dismiss.test.cjs:186` (refuse with dependents), `:197`/`:213`/`:224` (choices), `:257` (dismissed slug never satisfies), `:286` (auto-dismiss skips a cancelled row that another Epic's pending row depends on). |

**Detection backstop only (not prevention):** 3490 (`budget.cjs` `classifyPendingHolds`, `scheduler.cjs:1108-1157` emits `scheduler_stall_detected` with `heldByDependency`) and 3491 (Needs-you item per (cwd, blocker) after 30 min). They report a hold once it exists and do not stop one forming.

## Per-PRD verdicts

### 3487-dep-resolve-exact-satisfied-first — VERIFIED
- Resolver order exact-live → exact-satisfied → prefixed unresolved unless same-Epic twin → bare (same-Epic preferred) → satisfied bare → unresolved: `depSlugResolve.cjs:138`.
- Cancel marker (`cancelledAt` or `error` starting "cancelled via admin API"): `depSlugResolve.cjs:94-97`.
- `schedulerBatch.cjs:18,79-85` use `makeDepResolver`; grep for `\d+-` / `^\d` regexes in `schedulerBatch.cjs` finds none.
- 1047/1056 test at `schedulerBatchDepends.test.cjs:321`. Gate green.

### 3488-dep-resolve-one-rule-everywhere — VERIFIED
- `starvation.cjs:10,56-57`, `runVerify.cjs:48,234-235`, `health.cjs:25,607,831` all call `makeDepResolver`. Gate (`starvation-blocked-chains-resolver`, `runVerify`) green.

### 3489-prd-create-stores-full-dep-slugs — VERIFIED
- `prdCreate.cjs:257-269` resolves to full slugs, same Epic first. Tests `prdCreate-dep-full-slugs.test.cjs:53-119` green.

### 3490-stall-detector-names-held-rows — VERIFIED
- `budget-stall-holds.test.cjs:26` (cancel markers), `:35` (cancelled-only is not stalled), `:56` (names blocking row and status). `scheduler.cjs:1117-1157` emits `heldByDependency`.

### 3491-stall-dep-hold-needs-you — VERIFIED
- `stall-dep-hold-needs-you.test.cjs:129` post once, `:144` withdraw, `:162` no post under 30 min, `:184` restart. Audit rows `stall_dep_hold_*` at `scheduler.cjs:2635`.

### 3492-cancelled-row-dismiss — VERIFIED
- Dismiss to `prds-cancelled/<ts>/` (`queueOps.cjs:535-588`). Tests `cancelled-row-dismiss.test.cjs:145-324` cover the dependents rule from 3499, refusal of non-cancelled rows, auto-dismiss, and the admin route.

### 3493-outside-state-counts-epic-rows — VERIFIED
- `epicOutsideRead-queue-rows.test.cjs` green (working state plus pending/running counts from `remote.listJobs`-shaped rows, which now carry `epicId`/`sourcePromptId`, commit 5df971fe).

### 3494-branch-sweep-backoff — VERIFIED
- `branchSweep.cjs` persisted backoff and `branch_sweep_gave_up`; `branch-sweep-backoff.test.cjs` green (count, give-up at 3, skipped PRD, no repeat report).

### 3495-load-gate-excludes-own-processes — VERIFIED
- `loadGate.cjs:53-56,243` decide on net busy. `cpuSample.cjs` reads own `/proc` ticks. `load-gate-own-processes.test.cjs` green. `scheduler-operations.md` gains a paragraph with measured raw 6.3% → net 4.4% (60 s `/proc` sample).

### 3497-prd-create-refuses-cross-epic-duplicate — VERIFIED
- `prdCreate.cjs:290-300,689`; the 1047/1056 refusal test at `prdCreate-cross-epic-duplicate.test.cjs:66`. Green.

### 3498-prd-create-warns-cross-epic-files-overlap — VERIFIED
- `prdCreate.cjs:316-336` warns and never refuses. The test asserts it reuses schedulerBatch's exported `filesOverlap` (`:60`) and covers the same-Epic, completed and folder cases. Green.

### 3499-cancel-job-dependents-choice — VERIFIED
- `cancelDependents.cjs` plus `cancel-job-dependents.test.cjs`, `cancelDependents.test.cjs`, `prdAdminRoutes.test.cjs` (409 on refusal, 400 on a bad choice). Green.

### 3500-mcp-tools-duplicate-override-and-cancel-choice — VERIFIED
- `schedulerMcpServerCancelDependents.test.cjs:108-158` shows `dependents` and `allowDuplicateOf` forwarded and declared in the tool schemas. `prdAdminRouteParity` and `schedulerMcpServerGateFiles` green.

## Findings

### Critical
- none

### Important
- none

### Minor
- Self-review only (the review skills were not run). Nothing found: no secret handling, path inputs to `prds-cancelled/` are built via the ops path helper and slug-derived, and `allowDuplicateOf` is schema-validated as exact NN slugs.
- The worktree carries uncommitted deletions of `project-pages/home.html` and `demo-video/index.html`. They were listed as foreign work and are not part of this plan.

# Validation: runtime-state untrack plan (PRDs 2719–2723)

Base: none recorded in the PRD; used `3e22bcf0` (parent of the 2719 merge `b917d6ae`). Diff to HEAD `7ff98252` also contains unrelated Epics (nav consolidation, md-network); only plan files were reviewed.
PRD files found under `epics/bilko-still-tracks-…-7fdc518b/prds-archived/`.

Targeted gates (all 5 plan test files, one run): 5 files / 20 tests passed. `npm run lint:docs`: ok. Typecheck exit 0. `npm run lint` exit 0.

## integrate-never-clobbers-ignored-live-files — VERIFIED
- Test `integrateIgnoredLiveFiles.test.cjs` exists and passes (modify/delete + ff cases).
- All three `git merge` calls carry `--no-overwrite-ignore`: gitWorktree.cjs:1519, 1528, 1557.
- Auto-resolve never rm's ignored paths: `filterIgnoredPaths` gate at gitWorktree.cjs:1538-1544 returns ok:false naming the path; pre-merge check at :1512.
- **Real probe** (temp repo, real `integrateBranch`, exact PRD repro: base tracks ops/state, main untracks+ignores `ops/`, live file `LIVE`, branch commits `STALE`): result `{"ok":false,"reason":"refusing to integrate: branch touches ignored path(s) that exist on disk in the main checkout: ops/state","ignoredLivePaths":["ops/state"]}`; `cmp` of ops/state vs pre-integrate copy: byte-identical (`LIVE`); no merge state left, HEAD unchanged.
- Existing integrate tests pass (full suite below); typecheck passes.

## runtime-ops-namespaces-self-ignore — VERIFIED
- `RUNTIME_NAMESPACES` (scheduler, prompt-sessions, feedback, logs, ui-prefs, memory-clusters) opsOwnership.cjs:82; authored ones not included; flag lives on the namespace declarations (:99, :114).
- `ensureRuntimeIgnores` opsOwnership.cjs:336: existing dirs only, no git, `writeTextAtomicSync` from atomicFs, `checkOpsWrite` with declared writer `runtime-ignore`.
- Called from reconcile flat-sweep, scheduler.cjs:1665, roots via `resolveProjectRoot` (:1662).
- `opsRuntimeIgnore.test.cjs` passes (git status/check-ignore/untracked reviews/idempotence).

## worktree-carry-excludes-runtime-ops-state — VERIFIED
- gitWorktree.cjs `RUNTIME_CARRY_EXCLUDES` built from `RUNTIME_NAMESPACES`, applied to both `diff --name-only` and the `--binary` patch; `carriedPaths` derives from the filtered listing.
- `carryExcludesRuntimeState.test.cjs` passes. Existing carry/integrate tests pass (full suite).

## safe-untrack-tracked-runtime-ops-state — VERIFIED
- runtimeStateUntrack.cjs exports `findTrackedRuntimeState` (README.md excluded) and `untrackRuntimeState`; refusals for linked worktree, non-default branch, MERGE/CHERRY_PICK/REVERT/rebase markers, staged index, busy project; `git rm -r --cached` on tracked runtime paths only; commit ends with attribution; on-disk before/after list compared; root .gitignore untouched.
- `runtimeStateUntrack.test.cjs` passes. health.cjs:1368-1386 adds `tracked_runtime_state` as warn, `ok:true` (never RED).
- No UI/MCP route (declared out of scope).

## docs-fix-stale-bilko-citations-and-gitignore-claim — VERIFIED
- Checked read-only against ~/Projects/Bilko: `src/pages/session-manager-landing/{SessionManagerPage,ManualPage}.tsx`, `src/data/projectsRegistry.ts`, `projectsView.ts`, `src/data/standalone-projects.json`, `src/lib/manualClient.ts`, `docs/map.md`, `docs/host-contract.md` all exist; `### First-run setup outcomes` is at docs/observability.md:172 (telemetry.md cites it).
- Quote re-verified: map.md:7 opening paragraph ("host platform, not a product"); host-contract.md:21 holds the "ship their React page … endpoint stays in the host" rule (CLAUDE.md quote removed, not invented).
- develop/SKILL.md ~226 now states per-namespace `.gitignore`; `develop-skill-planning-rules` test and `lint:docs` pass. No Bilko file or CLAUDE.md edited.

## Full-suite results
- `npm run test:unit`: **5 files / 11 tests FAILED**, 925 files passed (8577 tests). Run twice, identical set (SM_SCHEDULER_*/SM_PROJECT_ROOT env was present from the job).
  - scripts/__tests__/page-surface.test.cjs (6 tests), src/preload/__tests__/apiSurface.test.cjs, src/renderer/lib/__tests__/zLayers.test.ts (`components/tabs/Library.tsx:837 z-index 50`), TelemetryNotice.test.tsx (2), renderer/web/__tests__/remoteApi.test.ts (15 s timeout).
  - None touch plan files; they trace to the concurrent nav-consolidation/page-library renderer work (Library.tsx, page-surface, preload). Not caused by this plan. The two renderer ones (TelemetryNotice, remoteApi) may also be load-sensitive; not isolated.
- `npm run typecheck`: exit 0. `npm run lint`: exit 0.

## Findings
**Important**
- Unit suite is red (11 failures, above) on HEAD; owner of the nav-consolidation Epic should fix (esp. zLayers: `src/renderer/components/tabs/Library.tsx:837`, apiSurface table, page-surface).

**Minor**
- health.cjs:1370 passes raw `allProjectCwds()` entries (may be worktree/agent cwds) to `findTrackedRuntimeState` rather than `resolveProjectRoot`; harmless, can double-report.
- host-boundary.md names `standalone-projects.json` without its `src/data/` prefix.
- `untrackRuntimeState` assumes self-ignore files exist; if run before `ensureRuntimeIgnores`, the untracked runtime files will appear in `git status`.
- PRD has no `Base:` line; base inferred.

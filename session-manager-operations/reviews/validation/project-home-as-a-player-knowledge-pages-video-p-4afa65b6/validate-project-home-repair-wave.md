# Validation: project-home repair wave (PRDs 2607-2613)

Base: e819c29c (known). Commits: 1283172b, bc4a40e8, aa3f3e92/c7830ed5, 1974b6b5, 1afaab46, 86995863, 1cb5ae0b.
Full-plan gates, all `SM_*` unset: `npm run typecheck` exit 0; `npm run test:unit` = 891 files passed, 8431 tests passed, 1 skipped, 0 failed.
The 4 previously red specs (apiSurface, ProjectHomeEmptyState, macroLibrary v4 upgrade, check-ops-path-literals) are in that green run.

## repair-library-arrays-default: VERIFIED
- useProjectPagesOutput.ts:56-57 and :77-78 store the value only when `Array.isArray`, else `NO_KNOWLEDGE` / `NO_VIDEOS`.
- ProjectHomeEmptyState.test.tsx stub now has the real shape; a new test mounts with a get() that has no arrays and asserts the empty state renders.

## repair-apisurface-pages-rename-delete: VERIFIED
- apiSurface.json:1325-1338 adds `projectPages.rename` and `projectPages.delete` as invoke/mutate, right after unwatch. apiSurface.test.cjs is unchanged and passes.

## repair-macro-library-version-test: VERIFIED
- macroLibrary.test.cjs:416 test renamed; it expects `real.builtinVersion` and `real.prompt`. No product file touched by this PRD.
- Note: c7830ed5 also touched seedAgentPersonas.test.cjs and builtinMacros.test.cjs (floor pin). Test-only.

## repair-seedkit-scheduler-home-path: VERIFIED
- seedKit.cjs:17,25 `kitDestDir()` returns `path.join(schedulerHome(), 'demo-video-kit')`. The os import is gone. No kit file requires schedulerPaths (grep empty).
- seedKit.test.cjs adds a `kitDestDir follows SM_SCHEDULER_HOME` test.

## repair-migrated-video-bridge: VERIFIED
- pagesLibrary.cjs:150 bridges the demo bytes with `injectPlayerBridge`. The id is still hashed from the original bytes (:149). The copy is verified against the bridged buffer (:88-93). `meta.report.bytes` is `bridgedBuf.length` (:161).
- Knowledge/overview migration is unchanged (it passes the raw buffer).
- pagesLibrary.test.cjs asserts the bridge marker appears exactly once, `.migrated` is byte-equal to the input, bytes match, and a second migrate writes nothing.

## repair-agent-facing-library-wording: VERIFIED
- mcpToolCatalog.cjs: the project_home_write purpose names `knowledge/overview/`. The project_demo_video_write purpose names `videos/<id>/` and says project_video_write is primary. "The only write path" is gone (grep clean in src).
- opsOwnership.cjs comment and api.d.ts doc comments updated. mcpToolCatalog.test.cjs asserts all of this.

## repair-data-model-tag-library-wording: VERIFIED
- dataModelErd.ts:703-708 and tagLibrary.ts:68 carry the new text. dataModelErd.test.ts needed no change.

## Findings
### Critical
- none
### Important
- none
### Minor
- Scope drift. The wave's diff range also carries unrelated commits from other Epics (tool-scope, artifact-only dispatch, seed persona text and seedVersion bumps, schedulerSandbox.cjs). Not attributable to these PRDs; the full suite is green with them.
- Migration test coverage: the bridge-injection fallback for a legacy file with no CSP meta is not covered by a dedicated test (playerBridge.cjs is the owner). Not exercised by the wave's spec.
- `session-manager-operations/project-pages/home.html` was modified in the tree before this run (foreign WIP). I left it untouched.

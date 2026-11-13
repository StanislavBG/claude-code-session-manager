# Validation: Run preview plan (Base 746f2ae3)

Gates re-run (SM_* unset, foreground): one vitest run over all 15 gate spec files + the real-process `appPreviewManager` / `appPreviewSweep` tests: 15 files / 278 tests passed. `npm run typecheck` exit 0, `npm run lint` clean (selectors, hooks, e2e budget 18/19), `npm run lint:docs` ok. Commits found for every PRD in `git log 746f2ae3..HEAD` (6a5344f4, 595a934f, 1b749da6, fda5e39d, 634fd41b, 68be8f8d, d0da3530, d78de1b0, a2374885, 4550d654, 24e557bb). `/code-review` and `/security-review` were not run as skills; self-review done (below).

## app-preview-scripts-primitive — VERIFIED
`src/main/lib/app-preview/appPreviewScripts.cjs` exists with the helpers; `appPreviewScripts.test.cjs` green; `APP_PREVIEW_SCRIPT_RE` in `ipcSchemas.cjs` matches the PRD's SCRIPT_NAME_RE (test in ipcSchemas-appPreview).
## app-preview-preload-api — VERIFIED
`src/preload/index.cjs`, `api.d.ts`, `apiSurface.json` carry `appPreview`; apiSurface + preload-surface tests green; typecheck green.
## app-preview-manager-primitive — VERIFIED
`appPreviewManager.cjs:182,206` spawns `npm run <script>` via resolveSpawn with `detachedSpawnOpts`, no `shell:true` (grep clean); script validated + checked against package.json (`:241-246`); URL watch, kill-tree. Real-process tests green.
## app-preview-renderer-store — VERIFIED
`src/renderer/state/appPreview.ts:21-34` toasts failed/unexpected-stop/running once per transition; test green.
## app-preview-main-ipc-wire — VERIFIED
`appPreviewIpc.cjs:103-118` handlers validated by zod (`ipcSchemas.cjs` appPreviewStart/Stop/Scripts); dir resolved in main from the active index (`resolveAppPreviewDir`), renderer sends only cwd+epicId. `index.cjs` registers handlers and calls `stopAll` in `runShutdownCleanup` and `before-quit`.
## app-preview-epic-control-ui — VERIFIED
`EpicAppPreview.tsx` mounted in `EpicDetail.tsx`; Open uses `window.api.shell.open({as:'external'})` (`:77`); refused starts toast from the component (`:47,54`). No `<webview>`/`<iframe>` (grep clean). Tests green.
## app-preview-stop-on-epic-close — VERIFIED
`promptSessions.ts` `markCompleted` stops before mergeToMain, `deleteEpic` stops; `epicWorktreeMerge.cjs` stops before integrating. Tests green.
## app-preview-setsid-orphan-sweep — VERIFIED
`appPreviewSweep.cjs` scans /proc environ markers; manager sweeps after kill; `index.cjs` boot `sweepOrphanedPreviews()` in whenReady. Sweep tests green.
## app-preview-stop-on-index-removal — VERIFIED
`activeIndexMerge.cjs` stops each `removedIds` entry fire-and-forget after the write; test green.
## app-preview-link-worktree-deps — VERIFIED
`appPreviewIpc.cjs:ensureWorktreeDeps` links node_modules via `worktreeDeps.linkDependencyDirs`, never blocks start; appPreviewIpc test green.
## app-preview-docs — VERIFIED
`code-map.md:87-94` and `src/main/lib/CLAUDE.md:7` document the feature; `lint:docs` ok.

## Plan-level checks
- Webview: `index.cjs:1283` still `preventDefault()` on will-attach-webview; will-navigate block unchanged; no webview/iframe added in renderer; URL reaches only `shell.openExternal` (main) / `shell.open({as:'external'})`. Only loopback URLs are ever detected.
- No `shell:true`; script validated by zod + `isValidScriptName` and checked against package.json keys; folder resolved in main.
- Kill on complete/delete/merge/index-removal/quit: all present (see above).
- Errors toast: component for refused starts, store for post-spawn failures.

## Findings
- Critical: none. Important: none.
- Minor: `src/main/lib/app-preview/appPreviewManager.cjs` stop-after-`chat.cancel` ordering in `promptSessions.ts` markCompleted means a failed stop is silently swallowed (by design; main merge stop is the backstop).
- Minor: the plan's combined diff also contains unrelated Epic Changes/diff-review work (DiffFileView, EpicChangesView, unifiedDiff, reviewMessage, gitTreeGuard) from a sibling plan; not reviewed here.
- Minor: `/code-review` and `/security-review` skills were not invoked; manual self-review found no injection, path traversal (dir from active index, `validatePath(cwd)`) or secret issues.

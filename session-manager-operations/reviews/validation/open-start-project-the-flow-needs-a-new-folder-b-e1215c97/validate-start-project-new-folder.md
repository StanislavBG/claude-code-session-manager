# Validation: start-project-new-folder

Base: 18fc132e (known). Commits: e1a2be6b (1614), b5a9b314 (1615), 7c353b71 (1616), eb1de088 (1617). PRD files located in `prds-archived/` of the main checkout's epic folder.

Gates re-run (scratch TMPDIR, node_modules symlinked from main checkout): `vitest run` on projectFolder.test.cjs, ipc-app.spec.ts, createPickedSession.test.ts, StartProjectDialog.test.tsx → 4 files / 61 tests passed; `npm run typecheck` exit 0; `npm run lint` exit 0.

## start-project-folder-helper (1614) — VERIFIED
- Exports `createProjectFolder`, `validateProjectName`; result codes invalid-name/invalid-parent/exists/io: `src/main/lib/projectFolder.cjs:49-89`.
- Name rules (empty, >100, `.`/`..`, leading `-`, `/` `\`, control chars; spaces/unicode accepted): `projectFolder.cjs:21-40`.
- Absolute + isDirectory parent check `:52-62`; `path.dirname(target) !== path.resolve(parentDir)` guard `:65-68`.
- Non-recursive `fs.promises.mkdir`, EEXIST → `{code:'exists', path}`, else `io`: `:70-86`.
- Test file present (85 lines) and passing.

## start-project-renderer-helper (1615) — VERIFIED
- Preload `createProjectFolder` → `ipcRenderer.invoke('app:create-project-folder', { parentDir, name })`: `src/preload/index.cjs:11`.
- `CreateProjectFolderResult` + method type: `src/preload/api.d.ts:1581-1584,1595`.
- `openProjectAt`, `openOrStartProject` delegating, `startNewProject` (no tab on failure): `src/renderer/lib/createPickedSession.ts:29-68`; docstrings updated.
- Test (43 lines) passing.

## start-project-ipc-handler (1616) — VERIFIED
- Schema strict, parentDir 1–4096, name 1–255, exported in `schemas`: `src/main/ipcSchemas.cjs:690-695,1203`.
- Handler `ipcMain.handle('app:create-project-folder', validated(...))` + `[main] create-project-folder` log: `src/main/index.cjs:787-791`; require at `:25`.
- Pick-directory comment states createDirectory is macOS-only: `index.cjs:775-777`.
- Schema tests in `tests/unit/ipc-app.spec.ts` (+23 lines), passing.

## start-project-dialog-ui (1617) — VERIFIED
- Component, all 7 testids, Modal title 'Open / Start Project': `src/renderer/components/StartProjectDialog.tsx:96-155`.
- Open existing → `openOrStartProject`, null leaves open: `:46-53`; Change… → pickDirectory: `:55-62`; Create disabled on blank/busy, Enter handled, preview, exists→'Open it' (`openProjectAt` then `onOpened`), other codes inline, thrown → toast: `:37,64-83,112-148`. autoFocus on input `:110`.
- App.tsx: `handleNewSession` opens dialog via useState (stable useCallback), parent = parentDirOf(activeTab.cwd) else `homeDir()`, onOpened closes + `setEpicsWorkspaceOpen(true)` + `openProjectPanel('terminal')`, stale comment updated: `src/renderer/App.tsx:217-237,730-735`.
- No hooks below early returns; lint exit 0. Test (109 lines) passing.
- **End-to-end chain**: dialog → `startNewProject(parentDir, name)` (`createPickedSession.ts:65`) → `window.api.app.createProjectFolder(parentDir, name)` → preload `invoke('app:create-project-folder', { parentDir, name })` (`preload/index.cjs:11`) → `ipcMain.handle('app:create-project-folder', validated(appCreateProjectFolder…))` (`index.cjs:787`, schema keys exactly `parentDir`,`name`, strict) → `createProjectFolder({ parentDir, name })` (`projectFolder.cjs:49`). Channel string and payload shape identical at every hop.

## Security / correctness review (self-review; combined diff 12 files, +590/−30)
Path traversal: name rejects separators/`..`/control chars and a dirname-equality guard backs it; mkdir is non-recursive so no parent creation or overwrite. Renderer-supplied `parentDir` is only required to be an existing absolute dir (acceptable: user-initiated, local app). No secrets; no `shell`; no duplicated helper.

## Findings
### Critical
- none
### Important
- none
### Minor
- `src/renderer/App.tsx:225-229` — if `homeDir()` rejects/hasn't resolved and no tab is active, `defaultParentDir` is `''`; Create then returns an inline "must be an absolute path" error rather than guiding the user to Change…. Cosmetic.
- `src/main/index.cjs:788-790` — handler wraps `createProjectFolder` in an async fn instead of the PRD's direct call form; behavior equivalent.

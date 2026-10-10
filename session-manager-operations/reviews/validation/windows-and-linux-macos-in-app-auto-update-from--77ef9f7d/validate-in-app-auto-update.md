# Validation — in-app auto-update plan

Base: `14869c8ae8d91422ea84f5b1e1fb483349544a80` (HEAD `3a185494`). PRD files found under
`epics/windows-and-linux-macos-in-app-auto-update-from--77ef9f7d/prds-archived/` (1805–1811).
Note: the worktree had no `node_modules`; I symlinked the main checkout's (gitignored, untracked) to run gates.
`electron-updater` is absent from that install, which is fine: it is lazily required and every test injects fakes.

## Gate re-run (all foreground)
- `npx vitest run` over all seven PRDs' test files (autoUpdater, updaterSettings, updaterIpc, preload-surface, SettingsUpdates, layout/__tests__/, RemoteMachinesSection): 11 files, 79 tests, all pass.
- `npm run typecheck`: exit 0 (both tsconfigs). `npm run lint`: all sub-lints clean.

## auto-updater-state-machine — VERIFIED
- `isAutoUpdateSupported` matrix: src/main/lib/autoUpdater.cjs:16-23 (darwin falls through to false; APPIMAGE non-empty check; SM_AUTO_UPDATE/SM_E2E).
- API + stable snapshot: :26-199 (`setState` is the only place the snapshot is rebuilt; no-op when nothing changed). `CHECK_INTERVAL_MS` :12.
- autoDownload/autoInstallOnAppQuit/allowPrerelease/allowDowngrade :80-83; `grep setFeedURL src/` (non-test) → none. Event mapping :84-100; check no-op while ready/deferred :108.
- requestInstall/cancelDeferred/60s poll: :155-185; `quitAndInstall(false, true)` only via `install()`.
- unsupported/disabled/error handling :36-39, :129-139, :108-118.
- Test file exists and passes; path appended to windows job vitest line, .github/workflows/ci.yml:91.

## auto-updater-settings-store — VERIFIED
- src/main/lib/updaterSettings.cjs: storePath :20, DEFAULTS frozen :17, load never throws :36-46, save rejects extra keys/non-boolean :50-55, writes via `config.writeJson` :58. Tests pass.

## auto-updater-preload-bridge — VERIFIED
- src/preload/index.cjs:425-435 (six methods, `install` sends `{force: force === true}`, onStatus returns unsubscribe, no URL param). Types `AutoUpdaterState`/`AutoUpdaterStatus` + `updater` in src/preload/api.d.ts:4-9, :2191-2197.
- src/renderer/lib/useAutoUpdater.ts: module singleton, one fetch + one subscription, torn down when the last consumer unmounts. Surface test + lint green.

## auto-updater-main-wire — VERIFIED
- package.json:136 `electron-updater ^6.8.9` in `dependencies`.
- src/main/updaterIpc.cjs: supported computed :48; lazy `loadUpdater()` only when supported :52-55; `isBusy` :59-63 with the specified reason text; `start()` once if enabled :107-110; handlers + strict zod :70-100; pushes via `sendIfAlive` :69.
- src/main/index.cjs:1103-1107 registers in try/catch with `logs.writeLine`.
- Extra checks: `grep -rn setFeedURL src/` excluding tests → none. `grep cmd:updater src/main/ipcSchemas.cjs src/main/webRemote.cjs` → none (those files differ from base only because of other plans; no updater strings in the diff).

## auto-updater-settings-ui — VERIFIED
- src/renderer/components/tabs/SettingsUpdates.tsx: testids `settings-updates`, `updates-check`, `updates-install`; Toggle bound to `status.enabled`; per-state copy; install-now confirm; errors toasted via `run()`. All hooks above the early return (:11-24). Rendered in SettingsAppPrefs.tsx. Tests pass, lint clean.

## auto-updater-footer-ready-chip — VERIFIED
- src/renderer/components/layout/AlmanacFooter.tsx:50 `useAutoUpdater()` at top level; ready / deferred / downloading branches :184-204 ahead of the existing ternary, which is unchanged for other states. Click → `install(false)`, info toast when deferred, error toast on reject (:59-70). Layout tests (incl. AlmanacFooter.autoUpdater) pass.

## remote-machine-version-display — VERIFIED
- src/renderer/components/remote/RemoteMachinesSection.tsx: version fetch keyed on `[peer.peerId, online]` via `remoteClient.send(.., 'cmd:app:version')`, silent on failure; strict numeric compare helper; note has no button/link; testids present. `cmd:app:version` already existed in ipcSchemas (pre-base); no new remote command. Tests pass.

## Findings
### Critical
- none
### Important
- none
### Minor
- src/main/lib/autoUpdater.cjs:80-83 — `autoInstallOnAppQuit = true` stays set when the user turns the toggle off after an update is downloaded; the already-downloaded update can still install on quit despite "disabled". Consider setting it false in the disabled branch of `applyEnabled`.
- src/renderer/components/layout/AlmanacFooter.tsx:61 — `install()` resolves to the status object itself, not `{ status }`; the `res?.status` read is always undefined, so every click does an extra `updater.status()` round-trip. Behaviour is correct; simplify by using the result directly.
- src/main/lib/autoUpdater.cjs:129-139 — `setEnabled(false)` while `ready` drops the 'ready' state and `latest`; re-enabling shows idle until the next check re-downloads/re-reports.
- src/renderer/components/remote/RemoteMachinesSection.tsx diff is large because it merges with the remote-view plan's refactor; the 1811 change itself is small and self-contained.
- Security self-review (no `/code-review` result captured beyond own read): no secrets, no path input; IPC payloads strict-zod; updater feed never caller-supplied; no remote command reaches the updater. Nothing to fix.

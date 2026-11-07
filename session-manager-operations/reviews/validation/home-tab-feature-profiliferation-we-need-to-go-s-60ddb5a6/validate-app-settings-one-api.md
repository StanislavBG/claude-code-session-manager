# Validation: app-settings-one-api plan

Base: 1bc1ccf61e4114803335ada430a038e709b65b5a. PRDs found in prds-archived/ (2689–2694); commits located via `git log` (a3c9d10b, 1455b585, ba457c74, 11a1cf56, 95aad53c, 4163b8d7).
Gates re-run (SM_* unset): the 5 new test files pass (14 tests); `npm run typecheck` exit 0; lint:selectors OK; lint:hooks OK; `vitest run src/renderer/state` 28 files / 337 tests pass.

## app-settings-file-helper — VERIFIED
- appSettingsFile.ts exports `appSettingsFile(path)` (lines 8, 23); appPrefs.ts:15, uiSettingsPrefs.ts:46, uiChromePrefs.ts:33 call it.
- No readJson/writeJson merge left in those three (grep: only a comment at uiChromePrefs.ts:8,54).
- appSettingsFile.test.ts passes; typecheck/lint green.

## app-pref-stores-use-settings-file-helper — VERIFIED
- epicsPrefs.ts:42,53,77; chatPrefs.ts:63,74,98; projectsPrefs.ts:27 use the helper; grep finds no `writeJson` in them.
- `vitest run src/renderer/state` green.

## updater-one-api-main — VERIFIED
- updaterIpc.cjs:76-80 `updater:status` returns `{...snapshot, check}`.
- updateCheck.cjs:93-98 skips the probe on SM_UPDATE_CHECK=0 and when auto-update is off.
- updater.oneApi.test.cjs passes.

## updater-one-api-renderer — VERIFIED
- useUpdateStatus.ts does not exist; grep for `updateStatus` / `app:update-status` in src finds no code hits.
- AlmanacFooter.tsx:29,48 uses useAutoUpdater and its `check` field (line 203); AlmanacFooter.update.test.tsx passes.

## voice-ipc-one-module-tts-persisted — VERIFIED
- All `voice:*` handlers are in voiceHotkey.cjs:298-337; voiceWizard.cjs:4 says it exports functions only; no other handlers in src/main.
- voiceSettings.cjs:303-317 load/save `ttsEnabled`; preload index.cjs:208 and api.d.ts:2068-2071 expose it; voice.ts:889 saves on toggle and :1120 hydrates at startup.
- voice.ttsPersist.test.cjs passes.

## raw-tabs-follow-settings-model — VERIFIED
- rawSessionModel.ts is deleted. Nothing imports it, and the picker and the `rawSessionModel` field are gone from SettingsAppPrefs.tsx and uiSettingsPrefs.ts (grep clean).
- sessions.ts:75-119 `resolveRawModel` calls `agents.resolveEpicModel`; a per-launch override wins (`modelOverride ??`), and a fallback keeps `--model` pinned.
- sessions.rawModel.test.ts passes.

## Findings
### Critical
none
### Important
none
### Minor
- Stale comments name the deleted `lib/rawSessionModel.ts`: terminalSettings.ts:23, editorPrefs.ts:13, HistoryDashboard.tsx:43, and src/main/lib/claude/effectiveModelInfo.cjs:35 (says it mirrors a RAW_MODELS fallback).
- uiChromePrefs.ts:8,54 comments still mention `writeJson`/`readJson`.
- The combined diff is 99 files. No secrets or path-traversal issues were seen in the reviewed areas, and the helper reuses the existing config IPC. `/code-review` and `/security-review` were not run; this is a self-review only.

# Validation: web-ui-sessions-operable-remotely (2026-11-05)

Base: unknown (no `Base:` line in the PRD) — commits taken from `a6b6232d..HEAD` (114b7458, edda2da6, a7d7b8ad, 593411ae, f4b39bad, be4f83a8; 41 files, +1025/-73).

## Gates
- `npm run test:unit`: **RED, 3 failures** (2 files, 8219 pass) — reproduced twice and in isolation:
  - `EpicsWorkspace.test.tsx` "Mark completed…" (status stays `proposed`) and "a completed Epic opens read-only… Resume" (`window.api.promptSessions.writeArchive is not a function`, promptSessions.ts:758): the test stub predates 593411ae, which moved the archive write to `promptSessions.writeArchive`.
  - `InlineConsentTerminal.test.tsx:172` "does not auto-type when no transcript exists": stub mocks `config.exists`, but `transcriptExists.ts` now calls `transcripts.exists` (edda2da6), so the stub's `false` is ignored.
  - Both are stale stubs caused by this plan (files not touched by the plan; scoped gates missed them) — not pre-existing.
- `npm --prefix web/remote-app ci && test`: green, 33 files / 217 pass, 1 skipped (includes `real-chain.browser.spec.ts`, 3 tests, real Chromium, 38 s).
- `npm run typecheck`: green (exit 0).

## Real probe
- Committed real-chain spec builds dist-web itself (`vite build --config vite.web.config.ts`, real RemoteRenderer + ws.ts + E2E boxes + webRemote.cjs dispatch) and passes: sessions:load follows app:launch-mode within 5 s; rekey mid-flight does not strand results; log:write reaches its ipcMain.on listener.
- I extended it with a scratch spec (deleted, not committed) that fed a sample tabs.json tab + real `promptSessionsIpc` read handlers + real `mergeActiveIndex`. Observed in Chromium: boot batch → `sessions:load` → `transcript:exists` (the new read channel; no more `config:exists` denial), so the persisted tab is not dropped. **The Epic list and approve click were NOT reached**: the harness's generic stub returns for ~60 unrelated channels made the frame throw (`n.every`, `.length` of undefined) after 3 stub-shape fixes, so the frame stayed blank. Harness limitation, not a product finding, but the full "list renders → approve round-trips to disk" Chromium chain is **unproven**.
- Substitute evidence (web shim → real apiSurface → real dispatcher → real handlers, no Chromium): `promptSessions.remoteHydrate.test.ts` (store filled from `promptSessions:load-active-index`, non-project cwd refused, refresh picks up a new Epic), `activeIndexMerge.test.cjs` (merge-by-id + tombstones), `promptSessionsIpc.test.cjs` (writeArchive under opsPath, writer `epics`, unregistered cwd refused). 239 tests green across `promptSessionsIpc`, `src/renderer/web`, remoteHydrate, `src/main/lib/epic`.

## Per PRD
### web-ui-boot-results-reach-frame-real-chain — VERIFIED
Real-chain spec exists and passes (above); UUID outer box id webRemote.cjs (114b7458 diff: `id: crypto.randomUUID()`); send-kind capture in remoteIpcDispatch.cjs `ipcMain.on` wrapper; rekey and log:write tests green.
### web-ui-keep-tabs-when-transcript-probe-denied — VERIFIED
`transcripts.exists` read channel, fenced `'transcript:exists': {field:'cwd', mode:'secret'}` in remoteIpcDispatch.cjs; `transcriptExists.ts:9` uses it; remoteApi.test.ts "N tabs for N persisted tabs" and "transcripts.exists is remote-readable" pass; probe observed `transcript:exists` after `sessions:load`. Caveat: caused the InlineConsentTerminal red (Finding I1).
### web-ui-epics-hydrate-through-read-ipc — VERIFIED
Handlers promptSessionsIpc.cjs:121-128 via `opsPath(cwd,'prompt-sessions')`, `assertRegistered` (line 47); fence rows `mode:'root'`; promptSessions.ts:880/955 use new channels; EpicDetail/EpicsWorkspace diff drops config.readText/watch; remoteHydrate test green.
### web-ui-epic-writes-persist-from-browser — VERIFIED (with I1)
`PERSISTENCE_CHANNELS` now only `sessions:save`, `layout:save` (remoteApi.ts:8-11); merge sends `removedIds`/`onlyIds` (promptSessions.ts:579, 710, 863); archive write via main `writeArchive` (single-writer 'epics'); approve failure toasts (promptSessions.ts:585). Caveat: the change broke two EpicsWorkspace tests (I1).
### web-ui-session-chat-first-and-version-skew-notice — VERIFIED
`isWebRemote()` forces chat mode and `WEB_TERMINAL_TOOLTIP` (epicTerminal.ts:13-18, EpicDetail.tsx:623-630 toast on chat:run refusal); `MIN_FULL_UI_VERSION='0.126.0'` banner in RemoteRenderer.tsx:260; web/remote-app tests pass.

## Findings
- **Important I1** — full `npm run test:unit` is red with 3 plan-induced failures: `src/renderer/components/__tests__/EpicsWorkspace.test.tsx` (stub needs `promptSessions.writeArchive`; promptSessions.ts:758) and `src/renderer/components/__tests__/InlineConsentTerminal.test.tsx:61,155` (stub needs `transcripts.exists`). Fix tests only; needs a follow-up wave before release.
- **Important I2** — Chromium proof of Epic list render + approve-to-disk absent (see Real probe); the committed real-chain spec only stubs `sessions:load` empty. Add a fixture-backed spec with sane per-channel stub shapes.
- Minor — no `Base:` line in the validate PRD; PRD files were all present.

## Still needs a release
1. `npm publish` of the desktop app (this plan's main/preload/renderer changes are only on main; HEAD is 0.127.0 + unreleased commits).
2. bilko.run shell publish (RemoteRenderer version banner, DevicePicker version rows, ws.ts hold fixes live only after the shell is published).
3. Restart each desktop after update; the owner's Windows machine (<0.126.0, list view) must be updated to ≥0.126.0 (ideally the new release) to get the full UI. Success fingerprint in `~/.claude/session-manager/logs/remote-audit-<date>.log`: `ipc:sessions:load`, `ipc:transcripts:exists`, `ipc:promptSessions:load-active-index` after the boot batch.

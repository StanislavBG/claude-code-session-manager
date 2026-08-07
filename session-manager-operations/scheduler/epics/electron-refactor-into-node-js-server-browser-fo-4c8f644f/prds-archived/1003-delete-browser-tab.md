---
title: Delete the Browser tab, DOM capture and click-recorder end to end
cwd: /home/bilko/Projects/session-manager
estimateMinutes: 75
sourcePromptId: electron-refactor-into-node-js-server-browser-fo-4c8f644f
sourceTabId: 8a7cbc80-2fb6-46f2-a86d-cbb7a7b9906e
dependsOn: [rehome-savebinary-off-browser-ns]
---
# Goal

Remove the embedded Browser tab and everything built on it — the WebContentsView host, DOM capture, the click-sequence recorder, the loopback browser-agent HTTP API, and the split terminal+browser view. This is a deliberate scope reduction ("going LIGHT"); the code stays recoverable in git history. Roughly 3,300 lines across ~20 files come out, along with 35 IPC channels. Chat links that currently open in the embedded browser fall back to the OS browser, which is the simpler and more correct behaviour.

# Acceptance criteria

- [ ] Main/preload deletions: `src/main/browserView.cjs`, `src/main/browserCapture.cjs`, `src/main/browserAgentServer.cjs`, `src/main/lib/browserAgentActions.cjs`, `src/preload/browserViewPreload.cjs`
- [ ] Renderer deletions: `src/renderer/components/tabs/Browser.tsx`, `src/renderer/state/browser.ts`, `src/renderer/lib/captureDest.ts`, `src/renderer/components/SplitAgentBrowser.tsx`, and the entire `src/renderer/components/tabs/browser/` directory (ActionBar, AddressBar, browser-primitives, CapturePanel, FindBar, ObservePanel, panel-primitives, RecorderPanel, SubTabStrip)
- [ ] Test deletions: `src/main/__tests__/browserView-destroyed-handler.test.cjs`, `src/main/__tests__/browserView-oauth-popup.test.cjs`, `src/main/__tests__/browserAgentServer.test.cjs`, `src/main/lib/__tests__/browserAgentActions.test.cjs`, `tests/unit/browserCapture.spec.ts`, `src/renderer/components/tabs/__tests__/Browser.test.tsx`
- [ ] `src/main/index.cjs` is fully unwired: the requires at ~12/13/43, the `createBrowserAgentServer({...})` block at ~44-48, `attachWindow` calls at ~309/310 and ~1148, `registerBrowserView`/`registerBrowserCapture` at ~1147/1149, the `isBrowserViewContents` guard at ~948, and `start()`/`stop()` at ~1180/~1290 are all removed with no dangling references
- [ ] `src/renderer/App.tsx` no longer imports or renders `SplitAgentBrowser`; the `setSplitView` toggle and any UI entry point that set it are removed
- [ ] `src/renderer/lib/handleChatLinkClick.ts` no longer imports `useBrowserState`; `openUrlInBrowserTab` is removed and link handling falls back to opening in the OS browser. `src/renderer/lib/chatFileLinks.ts`, `src/renderer/components/ChatTranscriptTurn.tsx` and `src/renderer/lib/__tests__/handleChatLinkClick.test.ts` are updated to match, with the test still asserting real link behaviour rather than being deleted
- [ ] The `browser` nav entry is removed from `src/renderer/lib/navGroups.ts` (line ~52) and its `browser` case + `Browser` import removed from `src/renderer/components/screenComponents.tsx` (lines ~17, ~92)
- [ ] The `browser:` namespace is removed from `src/preload/index.cjs` and `src/preload/api.d.ts`, including the `browser:open-tab-request` push subscription; browser-only schemas (e.g. `browserSetBounds`) are removed from `src/main/ipcSchemas.cjs`
- [ ] `src/renderer/components/TabBar.tsx` and any other file referencing browser state compiles cleanly with the state store gone
- [ ] `npm run typecheck`, `npm run lint`, `npm run test:unit`, `npm run test:e2e` and `npm run health` all pass
- [ ] grep across `src/`, `bin/`, `scripts/` and `tests/` returns zero live references to `browserView`, `browserCapture`, `browserAgent`, `useBrowserState`, `state/browser`, or `SplitAgentBrowser`

# Implementation notes

Depends on `rehome-savebinary-off-browser-ns` — Epic image attachments must already be off the `browser` IPC namespace before this lands, or `src/renderer/components/epics/attachments.tsx` breaks. Verify that PRD landed before starting.

Established by inspection — trust these:
- Sizes: browserView.cjs 916 L, browserCapture.cjs 728 L, browserAgentServer.cjs 224 L, browserViewPreload.cjs 118 L, browserAgentActions.cjs 114 L, Browser.tsx 165 L, state/browser.ts 483 L, SplitAgentBrowser.tsx 39 L.
- `SplitAgentBrowser` is imported at `src/renderer/App.tsx:9` and rendered at `:660` behind a `setSplitView(false)` handler. `src/renderer/components/TerminalStage.tsx` has comments referencing it but no code dependency — update the comments, keep the file.
- `src/main/scheduler.cjs` and `src/main/lib/summarize.cjs` matched a grep for "browser" only in comments/unrelated words — no code coupling.
- `scripts/check-unstable-selectors.cjs` matched only because it scans renderer files; it needs no edit.
- `src/main/index.cjs:948` has a webContents lock-skip guard `if (browserView.isBrowserViewContents(wc.id)) return;` inside a larger handler — remove the guard line, keep the surrounding handler intact.
- The `browser:open-tab-request` channel is fired from main to ask the renderer to open a URL in the embedded tab. With the tab gone, the whole request/response path goes; do not replace it with a shim.
- `handleChatLinkClick.ts` currently dispatches an `sm:navigate` event to switch screens after opening a tab. Removing that path should leave file-links (`chatFileLinks.ts`) working unchanged — only URL links change destination.

Follow the repo's no-backwards-compat-shims convention: delete outright, no stubs or feature flags. Electron is being KEPT in this phase, so `shell.openExternal` remains available for the OS-browser fallback — use it rather than `window.open`.

# Out of scope

- Editing CLAUDE.md or any documentation — that is the `docs-pass-browser-webremote-removal` PRD
- Removing Electron, the preload bridge, or any IPC transport machinery — Electron is explicitly being kept
- Touching Web Remote — that is the `delete-web-remote` PRD
- Building any replacement for DOM capture or click-recording
- Deleting `src/renderer/components/TerminalStage.tsx`

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).

---
title: Wire browser:open-tab-request popup handling + document browser/ OWNERS namespace
cwd: /home/bilko/Projects/session-manager
estimateMinutes: 18
sourcePromptId: psess-msareb8c-13
dependsOn: [907-real-popup-window-chrome-ua-for-oauth-identity-provider-flow]
---
# Goal

Make the Browser tab's popup handling actually functional for the common case of legitimate non-OAuth `window.open()` targets (e.g. a site opening a new tab/window for a link, a share dialog, a "view in new tab" action) and document the browser/ feature, closing two gaps found while investigating the Google-OAuth failure: (1) `src/main/browserView.cjs`'s `setWindowOpenHandler` fires `sendIfAlive(win, 'browser:open-tab-request', { url })` for every non-identity-provider popup, but grep across src/renderer/** finds zero listeners for `browser:open-tab-request` anywhere — it's dead code, so denied popups currently vanish with no fallback at all. (2) `session-manager-operations/browser/` has no README, unlike every other OWNERS namespace (prompt-sessions, scheduler, project-brief, feedback each have one per project CLAUDE.md convention) — this PRD adds one describing the popup-tab and OAuth-identity-provider-popup design so future changes don't have to re-derive it from code.

# Acceptance criteria

- [ ] A renderer listener for `browser:open-tab-request` is added (likely in src/renderer/components/tabs/Browser.tsx or src/renderer/state/browser.ts, following whatever existing pattern that file uses for other `browser:*` IPC subscriptions) that opens the denied URL as a new Browser sub-tab using the existing SubTabStrip/tab-creation mechanism already used for manually-opened tabs — reuse that mechanism, do not build a parallel one
- [ ] Verify src/main/browserView.cjs's setWindowOpenHandler (after PRD 907 lands) still only fires browser:open-tab-request for the non-identity-provider deny path, and that this new renderer listener is exercised by at least one unit test asserting a new sub-tab is created/focused with the requested URL when the IPC event fires
- [ ] Create session-manager-operations/browser/README.md documenting: the WebContentsView architecture (not <webview>, per src/main/browserView.cjs's own header comment), the popup-window design (identity-provider popups get a real child BrowserWindow per PRD 907; everything else denies and opens as a new in-app sub-tab via this PRD's listener), and that this namespace currently has no dedicated OWNERS entry in opsOwnership.cjs (confirm whether it needs one or intentionally doesn't, per project CLAUDE.md's 'No general OWNERS namespace' note — state the finding in the README, don't just assume)
- [ ] `timeout 180 npm run typecheck` passes
- [ ] `timeout 300 npx vitest run <the new/touched test file(s)>` passes
- [ ] `npm run lint:selectors` passes if any zustand selector code was touched in src/renderer/state/browser.ts

# Implementation notes

Depends on PRD 907 (907-real-popup-window-chrome-ua-for-oauth-identity-provider-flow.md) landing first — read its final diff to browserView.cjs's setWindowOpenHandler before starting, since this PRD's renderer listener only needs to handle the non-identity-provider deny branch. Key files: src/main/browserView.cjs (wireNavEvents/setWindowOpenHandler), src/renderer/components/tabs/Browser.tsx, src/renderer/components/tabs/browser/*.tsx (AddressBar/ActionBar/SubTabStrip), src/renderer/state/browser.ts, src/renderer/components/SplitAgentBrowser.tsx. Follow the existing SubTabStrip tab-creation code path exactly — do not invent a second way to add a browser tab. For the README, follow the shape of session-manager-operations/prompt-sessions/README.md or scheduler/README.md (on-disk shape, sole writer/owner, lifecycle) as the template. Read this repo's session-manager-dev:develop skill's standards.md for TDD/execution-discipline rules before starting.

# Out of scope

- Re-touching the OAuth/identity-provider popup path itself (PRD 907's responsibility)
- Adding a general "tabbed browsing history" or session-restore feature beyond opening the one requested URL as a new sub-tab
- Switching the rendering engine away from Electron's WebContentsView/Chromium — investigation confirmed this already IS real Chromium; no open-source browser-engine dependency is needed

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).

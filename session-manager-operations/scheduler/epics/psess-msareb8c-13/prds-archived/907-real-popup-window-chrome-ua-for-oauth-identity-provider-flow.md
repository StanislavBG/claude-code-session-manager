---
title: Real popup window + Chrome UA for OAuth identity-provider flows in Browser tab
cwd: /home/bilko/Projects/session-manager
estimateMinutes: 20
sourcePromptId: psess-msareb8c-13
---
# Goal

Fix Google (and other identity-provider) OAuth login failing inside the Browser tab's embedded WebContentsView. Root cause (confirmed): `wc.setWindowOpenHandler` in `src/main/browserView.cjs` (~lines 191-196) unconditionally returns `{ action: 'deny' }` for every `window.open()` popup and only fires an IPC event (`browser:open-tab-request`) that has no renderer listener anywhere — so Google's GIS popup (which needs a real `window.opener` to postMessage the credential back to, per its FedCM/GIS handshake) is silently killed. The user's recorded repro shows the flow degrading to a top-level in-view navigation through Google's consent screens that dead-ends at `https://accounts.google.com/gsi/transform` with no opener window left to signal. Separately, no custom User-Agent is ever set on the view (grep confirms zero `userAgent`/`setUserAgent` calls in `src/main/browserView.cjs`), so the view ships Electron's default UA containing `Electron/x.y.z`, which Google's OAuth endpoints can flag under their disallowed_useragent policy for embedded webviews. Build a targeted fix: classify `window.open()` targets by hostname against a small identity-provider allowlist (Google, and structured so more can be added later) and for those, return `{ action: 'allow', overrideBrowserWindowOptions: {...} }` from `setWindowOpenHandler` so Electron creates a REAL separate child window with a genuine `window.opener` relationship (instead of denying), and set a realistic desktop Chrome User-Agent string on both that popup and the main Browser WebContentsView. Non-identity-provider popups keep today's deny + `browser:open-tab-request` broadcast behavior unchanged (that path is addressed by a separate PRD).

# Acceptance criteria

- [ ] A new small module or inline helper in src/main/browserView.cjs classifies a URL's hostname against an identity-provider allowlist (at minimum accounts.google.com; structure the list/array so appleid.apple.com, login.microsoftonline.com, github.com can be added later without restructuring)
- [ ] wc.setWindowOpenHandler (currently always `return { action: 'deny' }` around line 191-196) branches: for identity-provider URLs, returns `{ action: 'allow', overrideBrowserWindowOptions: { webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } } }` (mirroring the security webPreferences already used in create() for the main view) so Electron spawns a real child BrowserWindow with a working window.opener; for all other URLs, unchanged deny + browser:open-tab-request behavior is preserved exactly as today
- [ ] A realistic desktop Chrome User-Agent string (matching the Electron build's actual Chromium version, e.g. via `process.versions.chrome`, not a hardcoded stale version) is set via `webContents.setUserAgent(...)` on both the identity-provider popup window's webContents and the main Browser WebContentsView created in create() (src/main/browserView.cjs), so the OAuth endpoint sees a normal Chrome UA rather than the Electron default
- [ ] The identity-provider popup window is properly cleaned up: its webContents 'destroyed' event is handled so no dangling reference/listener leaks (follow the existing cleanup pattern in create()'s `view.webContents.once('destroyed', ...)` block)
- [ ] Manual verification note in the PRD's own commit/PR description (not an automated test, since this requires live Google OAuth): describe how you verified the popup now opens as a real window and reaches a page other than a dead-end (this can be a code-path/manual walkthrough note if live Google login isn't testable in this environment — do not claim it was verified against live accounts.google.com unless it actually was)
- [ ] `timeout 180 npm run typecheck` passes
- [ ] Existing browserView-related unit/e2e tests (grep for browserView or Browser tab specs under src/**/*.test.* and e2e/**) still pass: `timeout 300 npx vitest run <matching files>`
- [ ] No `shell: true` added to any spawn call (project-wide rule) and no new webview/iframe embedding introduced (both remain blocked app-wide per index.cjs)

# Implementation notes

Key files: src/main/browserView.cjs (setWindowOpenHandler at ~191-196, create() at ~211-241, existing webPreferences pattern to mirror for the popup). src/main/index.cjs has the app's navigation lock (setWindowOpenHandler denies at the main-window level, will-navigate restricts to dev URL, CSP sets frame-src 'none') — read it to confirm this new popup path does not weaken that lock; the popup is scoped to browserView.cjs's own WebContentsView, not the main app window. `overrideBrowserWindowOptions` is a real, documented Electron `setWindowOpenHandler` return field — confirm current Electron version's support via `node -e "console.log(require('electron/package.json').version)"` or package.json, and check Electron's WindowOpenHandlerResponse docs shape (the field lives one level inside `{ action: 'allow', overrideBrowserWindowOptions: {...} }`). Do not attempt to spoof Google's OAuth policy beyond a normal, honest Chrome UA string — this is the standard, supportable mitigation (real Chromium engine + real UA + real popup window semantics), not a bypass technique. Read this repo's session-manager-dev:develop skill's standards.md for TDD/execution-discipline rules before starting.

# Out of scope

- Building a full custom-protocol/loopback OAuth redirect listener for the app's OWN identity — not needed here since claude.ai (loaded inside the Browser tab) is the OAuth relying party, not this Electron app itself
- Adding non-Google identity providers beyond making the allowlist structurally extensible
- Wiring the browser:open-tab-request IPC event to open a real new sub-tab for non-auth popups (separate PRD)
- Writing the session-manager-operations/browser/ README (separate PRD)

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).

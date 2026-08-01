# Browser — session-manager

This folder is the per-project artifact store for the Browser tab: DOM/screenshot captures saved
from the Capture panel. It does **not** store browser history, bookmarks, zoom, or recorder
exports — those live elsewhere (see "What's NOT here" below). This README also documents the
Browser tab's popup-window design, since that logic (`src/main/browserView.cjs`) has no other
home for its cross-cutting behavior.

## Storage layout

```
session-manager-operations/browser/
  screenshots/<timestamp>-<mode>.png     — CapturePanel "Save to scratch" for dataUrl captures (shot mode)
  dom-captures/<timestamp>-<mode>.txt    — CapturePanel "Save to scratch" for text captures (agent/html/a11y/selector modes)
```

Both subfolders are created lazily on first save — this directory may not exist on disk for a
project that has never used the Capture panel's "Save to scratch" action.

Filenames come from `src/renderer/lib/captureDest.ts`'s `destPath()` (ISO timestamp, sanitized,
plus the capture mode) — the single source of truth for the naming scheme, shared with the
Recorder panel's own exports (see below).

## Owner

Declared in `src/main/lib/opsOwnership.cjs`'s `OWNERS` map: `'browser': 'browser'` — the Browser
tab is its own sole writer, same pattern as every other namespace. `src/main/config.cjs`'s
`validateWrite()` narrowly scopes this path (alongside `feedback/`, `prompt-sessions/`,
`scheduler/`, `project-brief/`) as a project-root write grant. This namespace **does** have a
declared OWNERS entry — CLAUDE.md's "no general OWNERS namespace" note is about *other*
undocumented folders (`architecture/`, `design-mocks/`, `HUMAN_LEARN/`, `reviews/`) that are
written directly by skills via the `Write` tool, outside the app's own IPC write path; `browser`
was never one of those, it just lacked this README until now.

## What's NOT here

- **Browser history / bookmarks / zoom** — `~/.claude/session-manager/browser/{history,zoom,bookmarks}.json`
  (machine-wide, not per-project). History/zoom are written from the main process — see
  `browserView.cjs`'s `HISTORY_PATH`/`ZOOM_PATH`. Bookmarks are written from the **renderer**
  store instead, via `window.api.config.writeJson` — see `src/renderer/state/browser.ts`'s
  `BOOKMARKS_FILE`/`toggleBookmark`.
- **Recorder "Export → File" (`.md`)** — goes through a native OS Save dialog
  (`browser:save-recording`), writing to whatever path the user picks; not routed through
  `config.cjs`'s write-boundary check at all, so it isn't bound to this folder.
- **Recorder "Export → Playwright spec" (`.spec.ts`)** — written to `<cwd>/tests/e2e/`, a
  separate write grant in `config.cjs` (existing e2e spec convention), not this namespace.

## Popup-window design (identity-provider OAuth vs. everything else)

`wireNavEvents()`'s `wc.setWindowOpenHandler()` in `browserView.cjs` is the single decision point
for every `window.open()` / `target="_blank"` / ctrl-click inside an embedded page:

1. **Identity-provider popups** (`IDENTITY_PROVIDER_HOSTS`, currently just
   `accounts.google.com`) get `action: 'allow'` — a real child `BrowserWindow` with the same
   locked-down `webPreferences` as the main view. Google's GIS/FedCM login flow needs a genuine
   `window.opener` to `postMessage` the credential back to; denying the popup silently breaks the
   handshake. The popup also gets a realistic desktop Chrome UA
   (`buildChromeUserAgent()`, built from `process.versions.chrome` — not Electron's default UA,
   which OAuth endpoints can flag) and its `webContents.id` is registered in
   `browserViewContentsIds` so `index.cjs`'s global `will-navigate` nav-lock exempts it too (the
   consent/callback redirect chain needs to navigate freely, same as the main Browser view).
2. **Every other popup** gets `action: 'deny'` (no native window at all) and, if the URL has an
   `http(s)://` scheme, `sendIfAlive(win, 'browser:open-tab-request', { url })` is broadcast to
   the renderer instead. `src/renderer/components/tabs/Browser.tsx` subscribes to this via
   `window.api.browser.onOpenTabRequest` and calls the browser store's `openTab({ url })` — the
   exact same sub-tab-creation path the SubTabStrip's "+" button uses. This is how a legitimate
   non-OAuth popup (a share dialog, "open in new tab" link, etc.) actually surfaces to the user,
   instead of vanishing when the native popup is denied.

Extending the identity-provider allowlist (Apple, Microsoft, GitHub OAuth, …) is a one-line add to
`IDENTITY_PROVIDER_HOSTS` — no other restructuring needed, per that constant's own comment.

# In-App File Editor — PRD Set Overview

## Goal

Give Session Manager a first-class, full-page **Editor** experience in the main-space
(where the terminal lives). When a user clicks a text/markdown/HTML/image file in the
**Files** sidebar — or clicks a file link in the **terminal** — the file opens *inside*
the app for viewing and editing, instead of being shunted to an external editor.

This is **not** a new left-nav tab. Files remains the launch point. The Editor is a
main-space scene (a `NavKey` like `terminal` / `agent-view`) that the app navigates to
when a file is opened.

## Why

- The current flow opens previewable files via `openExternal` / external `code|cursor|subl`.
  The user loses context and leaves the cockpit.
- The user wants to **view and work with files** in-app: read markdown, edit configs,
  and — critically — use **HTML as a visualization layer** for project artifacts
  (graphs, charts, rendered project-structure views). That requires an in-app renderer
  that can run the page's own scripts safely.

## Scope of the set

| PRD | Title | Outcome |
|-----|-------|---------|
| 01 | Editor scene + open-files store | A bare main-space `editor` scene with a tab strip; Files-tree clicks open files into it and navigate there. |
| 02 | Monaco edit + save + dirty tracking | Editable Monaco pane, language-by-extension, Cmd-S atomic save, dirty dots, unsaved-close guard. |
| 03 | Rendered preview (Markdown + HTML) | Markdown → sanitized HTML; HTML → sandboxed iframe that runs the page's scripts (visualization layer). Edit↔Preview toggle per file. |
| 04 | Terminal-link integration + images + polish | Terminal file links open text files in-app (URLs stay external); image viewer; e2e tests; typecheck. |

PRDs are **ordered** (01 is the foundation). They are implemented directly in this branch,
not queued in the scheduler.

## Key decisions (locked with the user)

1. **Edit + save**, not read-only. Monaco-backed.
2. **Markdown**: rendered with `marked` → sanitized with `DOMPurify`, shown in a styled
   container. No scripts. Edit↔Preview toggle.
3. **HTML**: **both fully-rendered and editable**. Rendered in a sandboxed `<iframe>` with
   `allow-scripts` but **without** `allow-same-origin`, so the page's own JavaScript
   (D3, Chart.js, interactive structure views) runs in an **opaque origin** — isolated
   from the app, the user's files, and Electron internals. Edit↔Preview toggle.
4. **Terminal links**: text/previewable files open in the in-app Editor; **URLs** continue
   to open in the OS browser (they are references, not local files).
5. **No new left-nav tab.** Files is the launch point; Editor is a main-space scene.

## Security model for HTML rendering

Threat: a malicious `.html` in a project could run JS when previewed. Mitigations:

- `sandbox="allow-scripts allow-popups allow-forms"` — **omits `allow-same-origin`**, so the
  iframe document has an **opaque origin**: no access to `window.parent`, no app cookies /
  localStorage / IPC bridge, no reading the user's filesystem via same-origin tricks.
- Loaded by `file://` URL (or a scoped protocol) so the page's **relative assets** resolve,
  enabling real visualizations. `frame-src file:` is added to the renderer CSP.
- The Electron `will-navigate` / `setWindowOpenHandler` guards are untouched — they govern
  the **top-level** window, not sandboxed child frames, and popups from the frame are still
  denied window-open by the host handler.
- Markdown never gets an iframe; it is sanitized HTML in the host document.

Residual risk accepted: a sandboxed-but-scripted local page can make outbound network
requests (needed for CDN-hosted viz libs). This matches the user's stated intent of using
HTML as a visualization layer for their own project files.

## Non-goals (this set)

- PDF rendering (heavy dep — future).
- Multi-cursor collaborative editing / LSP / IntelliSense beyond Monaco defaults.
- Binary/hex editing.
- Diff view (future; Monaco supports it, but out of scope here).

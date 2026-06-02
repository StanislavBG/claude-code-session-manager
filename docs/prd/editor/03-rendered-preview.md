# PRD 03 — Rendered preview (Markdown + HTML) with Edit↔Preview toggle

## Outcome

Markdown and HTML files gain a **rendered view** alongside the Monaco source view, with a
per-file **Edit ↔ Preview** toggle in the Editor header.

- **Markdown** → rendered with `marked`, sanitized with `DOMPurify`, shown in a styled
  prose container (no iframe, no scripts). Defaults to **Preview**.
- **HTML** → rendered in a **sandboxed `<iframe>`** that runs the page's own scripts, so it
  works as a **visualization layer** (D3, Chart.js, interactive project-structure views).
  Defaults to **Preview**. Editing the source and toggling back re-renders.

## Dependencies

Add as **direct** deps (currently only transitive):

```
npm i marked dompurify
npm i -D @types/dompurify   # if marked/dompurify types aren't bundled
```

(`marked` ships its own types.) Pin to the resolved versions; keep the renderer-only.

## Files

- **NEW** `src/renderer/components/tabs/editor/MarkdownPreview.tsx` — `marked` + `DOMPurify`.
- **NEW** `src/renderer/components/tabs/editor/HtmlPreview.tsx` — sandboxed iframe.
- `src/renderer/components/tabs/EditorView.tsx` — header with Edit/Preview segmented toggle;
  pick pane by `viewMode[path]` (from store) with per-extension default.
- `src/renderer/state/editor.ts` — `viewMode` map + `setViewMode` (declared in PRD 01).
- `src/main/index.cjs` (or wherever the renderer CSP is set) — add `frame-src file:` (and
  keep `img-src`/`style-src` permissive enough for local viz). Verify against the existing
  CSP string; do not loosen `script-src` for the **host** document.

## View-mode defaults

- `.md` / `.mdx` / `.markdown` → `preview`
- `.html` / `.htm` → `preview`
- everything else → `edit` (and the toggle is hidden for non-renderable types)

`setViewMode(path, mode)` persists the user's choice for the session. Toggle only shows for
markdown + html.

## MarkdownPreview

- `marked.parse(text)` → `DOMPurify.sanitize(html)` → `dangerouslySetInnerHTML` in a
  `prose prose-invert` container (reuse the styling already used by DocumentViewer's md path).
- GFM enabled (tables, fenced code). Code blocks keep monospace styling.
- Links: open via `window.api.app.openExternal` for `http(s)`; intra-doc anchors are fine.
  (Use a click handler on the container that intercepts `<a>` clicks.)
- Re-renders when the editor text changes (live preview reflects unsaved edits — read the
  pane's current text, not just the on-disk content).

## HtmlPreview (visualization layer)

- Render `<iframe>` whose **document is the file**:
  - Preferred: `src={`file://${path}`}` so the page's **relative assets** (./chart.js,
    ./data.json, images) resolve. Requires `frame-src file:` in CSP.
  - `sandbox="allow-scripts allow-popups allow-forms"` — **NO `allow-same-origin`** → opaque
    origin. The frame can run scripts and fetch from CDNs but cannot reach the host app,
    its IPC bridge, localStorage, or the user's files via same-origin.
- A small header note / shield icon: "Sandboxed preview — scripts run in an isolated origin."
- If the file is large or fails to load, show the source view with an inline notice.
- Live edits: when in Preview after editing, re-render from current buffer. Because `file://`
  src reflects on-disk content, **Preview of unsaved HTML edits renders via `srcdoc`** built
  from the current buffer with an injected `<base href="file://<dir>/">` so relative assets
  still resolve; once saved, it can switch back to `src=file://`. (Implement srcdoc path; it
  covers both saved and unsaved and keeps one code path.)

## EditorView header

```
<name>   [ Edit | Preview ]            (toggle only for md/html)     [Reveal] [Open]
```

- Segmented control bound to `viewMode[path]`.
- Keyboard: optional Cmd-E toggles edit/preview for the active md/html file (nice-to-have).

## Acceptance criteria

1. Opening a `.md` shows the rendered markdown (headings, lists, tables, fenced code) by
   default; toggling to Edit shows Monaco source; edits live-update the preview.
2. Opening an `.html` containing an inline `<script>` that draws a chart (e.g. a canvas or
   an SVG via JS) **renders the chart** in Preview; toggling to Edit shows the source.
3. The HTML iframe cannot reach the host: a script doing `window.parent.location` or reading
   `window.parent.document` throws / is blocked (opaque origin) — app keeps working.
4. Markdown is sanitized: a `<script>` or `onerror=` in a `.md` does **not** execute.
5. Non-renderable types (`.ts`, `.json`) show no toggle and open straight in Edit.
6. CSP change does not break the rest of the app (terminal, existing tabs render fine).
7. `npm run typecheck` passes; `npm run build` succeeds (marked/dompurify bundle cleanly).

## Security restatement

Host document `script-src` is **unchanged**. Only the **sandboxed iframe** runs untrusted
page scripts, in an opaque origin, by explicit user action (opening an HTML file they chose).
Markdown is sanitized and never scripted. This is the documented, intended visualization path.

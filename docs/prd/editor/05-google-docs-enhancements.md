# Editor PRD 05 — Google-Docs feel + wide file-type support (v0.17.0)

Goal: make the in-app Editor scene (`NavKey 'editor'`, `EditorView.tsx`) feel closer to
Google Docs and open a much wider range of files. Grounded in a 4-agent research sweep of
the existing implementation. **Zero new npm dependencies** — everything rides on libs already
in `package.json` (marked, dompurify, monaco, zustand, Tailwind) plus the existing `smfile://`
privileged scheme and Chromium's built-in PDF viewer.

## Context the implementation must respect

- The `prose prose-invert` classes on `MarkdownPreview` were **inert** — `@tailwindcss/typography`
  is not installed. Real styling lives in hand-written CSS in `styles.css` mirroring the existing
  `.tiptap-content` block (paper-warm palette).
- App theme is already a light "paper-warm" palette — lean into it for the Docs page look.
- `smfile://` (src/main/index.cjs) already serves home-scoped files (25 MB cap, MIME-mapped,
  `assertInsideHome`). Adding a browser-renderable type = one `SMFILE_MIME` entry + a pane.
- `files.cjs readFile` is UTF-8-only with a 5 MB cap — the binary-garble + large-file bottleneck.
- Invariants: all paths through `validateHomePath`/`assertInsideHome`; atomic writes via tmp+rename;
  no remote reads in production; Toast is the user-facing error channel.

## A. Google-Docs look & feel

1. **Page canvas + real prose typography.** Markdown preview renders on a centered white "sheet"
   (max-w, margins, soft shadow) over the paper gutter. New `.markdown-body` CSS in `styles.css`
   (mirrors `.tiptap-content`). Replaces the dead `prose prose-invert` classes.
2. **Document outline / TOC panel.** Auto-generated from markdown headings (`marked.lexer`),
   click-to-scroll, collapsible left rail. Headings get slug `id`s in the rendered HTML.
3. **Live status bar.** Word count · char count · reading time (derived from the buffer) and,
   for code, cursor `Ln:Col` + language (from Monaco). Bottom strip in `EditorView`.
4. **Autosave + "All changes saved" indicator.** Debounced (~1.2 s) autosave reusing `save()`;
   header pill cycles Saving… → Saved → Unsaved. Per-save toast suppressed during autosave
   (it would spam). User toggle to disable autosave.
5. **Split view + markdown formatting toolbar.** New `'split'` ViewMode renders Monaco | live
   preview side by side. A markdown toolbar (bold/italic/H1-3/list/quote/code/link) inserts
   syntax at the Monaco selection via `executeEdits`.
6. **Editor preferences (persisted).** Font-size/zoom, word-wrap, minimap toggles in a small
   `useEditorPrefs` store backed by localStorage; live-applied via `ed.updateOptions` (no remount).
   Custom Monaco "paper" + "dark" themes matching the app palette; sticky scroll on.
7. **Focus mode.** Hides the tab strip + header for distraction-free writing; Esc exits.

## B. Wide file-type support

8. **Binary detection + graceful fallback.** `files.cjs readFile` reads a Buffer first, applies a
   NUL-byte heuristic, and returns `{ binary, mime, size }` instead of garbled UTF-8. New
   `BinaryPane` shows size + type + Open-externally / Reveal (reusing the header actions).
9. **PDF viewing.** `.pdf` → `SMFILE_MIME`; `PdfPane` loads it in an `<iframe src={smfile://…}>`
   (Chromium's built-in viewer). `frame-src smfile:` already permits it.
10. **CSV / TSV table view.** `TablePane` renders delimited text as a scrollable table with a
    quoted-field-aware parser; Edit↔Preview toggle keeps raw editing available.
11. **More image formats.** `avif`, `bmp` added to `IMAGE_EXTS` + `SMFILE_MIME` (Chromium-native).

## Out of scope (documented, not built)

- Office docs (docx/xlsx) inline — heavy libs; route to Open-externally instead.
- General format-on-save — needs per-language in-browser formatters.
- Reusing the TipTap `doc-editor` WYSIWYG for `.md` — its frontmatter normalization is unsafe for
  surgical edits to code/PRD files; the `editor` scene stays Monaco-first.

## Acceptance

- `npm run typecheck` passes. App builds. Opening a `.md` shows the page canvas + outline +
  status bar; toggling Split shows editor+preview; a `.pdf` opens inline; a `.csv` shows a table;
  a binary file shows the fallback pane (not garbage); autosave indicator reflects save state.

# PRD 02 — Monaco edit + save + dirty tracking

## Outcome

The Editor content host becomes an editable **Monaco** pane for text files: syntax
highlighting by extension, dirty tracking, **Cmd/Ctrl-S** atomic save, and an
unsaved-changes guard on close. The tab strip shows a dirty dot.

## Files

- **NEW** `src/renderer/components/tabs/editor/CodeEditorPane.tsx` — Monaco wrapper for one file.
- `src/renderer/components/tabs/EditorView.tsx` — host the pane; own keybindings + save.
- `src/renderer/components/layout/FileTabBar.tsx` — dirty dot per tab (•) + close-guard hook.
- `src/renderer/state/editor.ts` — `dirty` map already declared in PRD 01; use it.
- Reuse `src/renderer/components/ui/JsonEditor.tsx` as the Monaco reference (same `@monaco-editor/react`).

## CodeEditorPane behavior

- Loads content via `window.api.files.read(path)` on mount / path change. Shows loading +
  error states (mirror DocumentViewer). Respects the existing 5 MB read cap (show the
  main-side error message as-is).
- Monaco `Editor` with:
  - `language` resolved from extension (ts/tsx/js/jsx/json/py/go/rs/rb/c/cpp/java/sh/css/
    scss/html/xml/yaml/toml/ini/sql/md → markdown, etc.; fallback `plaintext`).
  - `path` = the file path (stable model URI; matches JsonEditor pattern).
  - theme matching the app (reuse JsonEditor's theme setup), `wordWrap` on for prose exts.
  - `automaticLayout: true` so it fills the scene and reflows.
- `onChange`: compare against the last-saved baseline; call `useEditor.setDirty(path, isDirty)`.
- Holds the current editor text in a ref so the host's save handler can read it without a
  store round-trip per keystroke (hot path stays contiguous — no per-keystroke store writes
  beyond the boolean dirty flag).

## Save

- Save is owned by `EditorView` so a single Cmd-S handler serves whichever pane is active.
- `Cmd/Ctrl-S` (when the Editor scene is active and focus is inside it):
  `window.api.files.write(path, text)`. On `ok`: `setDirty(path, false)`, update the pane's
  saved baseline, `toast.info('Saved <name>')`. On failure: `toast.error(result.error)`.
- Monaco's own Cmd-S command is also bound (`editor.addCommand`) so saving works while the
  cursor is in the editor; both paths converge on the same save function.
- Saves go through `files.write` (atomic tmp+rename, credential-file rejection) — do **not**
  re-implement writing.

## Dirty UX

- `FileTabBar`: when `dirty[path]` is true, render a filled dot in place of / next to the
  close glyph (VS Code convention). Existing close button still closes.
- **Close guard**: closing a dirty tab (tab `×`, middle-click, Close menu) prompts a small
  confirm ("Discard unsaved changes to <name>?" → Discard / Cancel). `closeAll` /
  `closeOthers` prompt once if any target is dirty. Use the existing in-file `Modal` pattern
  (see FileTree) or a minimal inline confirm — no new modal framework.

## Acceptance criteria

1. Opening a `.ts`/`.json`/`.md` file shows it in Monaco with correct syntax highlighting.
2. Typing marks the tab dirty (dot appears); saving (Cmd-S) clears the dot and persists to
   disk (verify the file content changed on disk).
3. Saving a file the app shouldn't touch (e.g. a credentials path) surfaces the main-side
   rejection via toast, and the file is unchanged.
4. Closing a dirty tab asks before discarding; Cancel keeps the tab + edits.
5. A >5 MB file shows the "too large" message instead of hanging.
6. `npm run typecheck` passes.

## Notes

- Markdown/HTML still render as editable source here; the rendered-preview toggle is PRD 03.
- Image files are not editable; they get the viewer in PRD 04. Until then they may fall back
  to the existing DocumentViewer image branch.

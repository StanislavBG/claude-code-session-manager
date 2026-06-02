# PRD 04 — Terminal-link integration + image viewer + polish

## Outcome

Clicking a **file** link in the terminal opens it in the in-app Editor (not an external
editor). **URLs** still open in the OS browser. Image files get an in-app viewer. The
feature is covered by an e2e test and ships clean.

## Files

- `src/renderer/components/Terminal.tsx` — file-link `activate()` opens in-app instead of
  calling `window.api.app.openFileInEditor`.
- `src/renderer/state/editor.ts` — used by Terminal to open the file.
- `src/renderer/App.tsx` — listen for an `sm:open-editor` event (nav bridge) so Terminal,
  which has no `navigate`, can route to the Editor scene.
- **NEW** `src/renderer/components/tabs/editor/ImagePane.tsx` — image viewer (reuse
  DocumentViewer's image/svg branch: raster via `file://`, svg inline).
- `src/renderer/components/tabs/EditorView.tsx` — route image extensions to `ImagePane`.
- `tests/e2e/` — add a Playwright spec.

## Nav bridge (Terminal → Editor scene)

Terminal is rendered deep in `MainPane` and has no access to `navigate`. Use a tiny,
emit-only bridge (same spirit as CommandPalette's dispatch):

- Terminal `activate()`:
  ```ts
  const filePath = pathPart.replace(/(?::\d+)+$/, '')
  const abs = filePath.startsWith('/') ? filePath : `${cwd}/${filePath}`
  useEditor.getState().openFile(abs)
  window.dispatchEvent(new CustomEvent('sm:open-editor'))
  ```
- `App` adds `useEffect(() => { const h = () => navigate('editor'); window.addEventListener('sm:open-editor', h); return () => window.removeEventListener('sm:open-editor', h) }, [navigate])`.
- **URLs are untouched**: `WebLinksAddon` keeps routing http(s) to `app.openExternal`.
- The line/col from `path:line:col` is preserved for Monaco: pass it through `openFile` (or a
  variant) and have `CodeEditorPane` reveal the line on mount when present. Minimal version:
  store `{ path, line?, col? }` for the pending open and let the pane `revealLineInCenter`.
- Non-existent paths: `files.read` returns an error; the pane shows it. (Optionally pre-check
  with `files.read` and fall back to a toast — but opening + showing the error is acceptable.)

The old `app.openFileInEditor` IPC and the external-editor opener stay in place (still used
by `Projects.tsx` "Open in editor" and as the explicit "Open externally" affordance); the
terminal just no longer routes through it for in-app-previewable files.

## ImagePane

- Raster (png/jpg/jpeg/gif/webp): `<img src={`file://${path}`}>` centered, `object-contain`.
- SVG: read text via `files.read`, render inline (`dangerouslySetInnerHTML`) — matches the
  existing DocumentViewer behavior. (SVG is local + user-chosen; acceptable, consistent with
  current app behavior. If hardening later, sanitize with DOMPurify SVG profile.)
- No edit mode for images (toggle hidden).

## Header affordances (carry over from DocumentViewer)

Keep **Open** (default app) and **Reveal** (OS file manager) buttons in the Editor header via
`window.api.files.openExternal` / `showInFinder`, so users can still escape to native tools.

## E2E test

`tests/e2e/editor.spec.ts` (Playwright Electron, under xvfb — match existing harness):

1. Launch app, ensure a session/tab with a known cwd (use the repo or a temp dir seeded with
   fixtures: `note.md`, `data.ts`, `viz.html`).
2. Switch sidebar to **Files**, click `note.md` → assert the Editor scene mounts and a tab
   labeled `note.md` is present.
3. Toggle to **Edit**, type, assert dirty dot; trigger save, assert dot clears and the file
   on disk changed.
4. Click `viz.html` → assert an iframe is present with the expected `sandbox` attribute and
   **no** `allow-same-origin` token.
5. (If feasible in-harness) emit a terminal file-link click path and assert the Editor opens.
   If terminal link simulation is impractical, unit-cover the path-resolution + event emit
   instead.

## Acceptance criteria

1. Clicking `src/foo.ts:12` in the terminal opens `foo.ts` in the in-app Editor at line 12;
   the external editor is **not** spawned.
2. Clicking an `https://…` link in the terminal still opens the OS browser.
3. Clicking an image in the Files tree shows it in the in-app image viewer.
4. The e2e spec passes under `npm run test:e2e`.
5. `npm run typecheck` passes; `npm run build` succeeds.

## Ship checklist (done at the end of the set, before publish)

- `npm run typecheck` ✓
- `npm run build` ✓
- `npm run test:e2e` ✓ (or documented why a sub-step was skipped)
- Bump version in `package.json`, update any in-app version display.
- Commit on the feature branch with a descriptive message.
- **Pause for user approval before `npm publish` + relaunching via npx** (per locked decision).

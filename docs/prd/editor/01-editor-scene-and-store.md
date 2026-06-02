# PRD 01 — Editor scene + open-files store

## Outcome

A bare main-space **Editor** scene exists, navigable as `NavKey = 'editor'`. It owns a
horizontal **open-files tab strip** and a content area. Clicking a previewable file in the
Files sidebar opens it in the Editor and navigates there. With nothing open it shows an
empty state.

## Files

- **NEW** `src/renderer/state/editor.ts` — zustand store for open files.
- **NEW** `src/renderer/components/tabs/EditorView.tsx` — the scene (tab strip + content host).
- `src/renderer/components/LeftNav.tsx` — add `'editor'` to the `NavKey` union.
- `src/renderer/App.tsx` — add `'editor'` to `SCREEN_KEYS`.
- `src/renderer/components/MainPane.tsx` — render `<EditorView />` for `active === 'editor'`
  (bare, draws own chrome — same treatment as `agent-view`).
- `src/renderer/components/layout/AlmanacSidebar.tsx` — thread an `onOpenFile` down to
  `FilesMode` → `FileTree`; default it to open-in-editor + navigate.
- `src/renderer/components/layout/FileTree.tsx` — already calls `onPreviewFile(path)`; keep.

## Store shape (`useEditor`)

```ts
export interface OpenFile { path: string; name: string }
type ViewMode = 'edit' | 'preview'        // PRD 03 uses this; default per-ext
interface EditorState {
  openFiles: OpenFile[]
  activeFilePath: string | null
  dirty: Record<string, boolean>          // PRD 02
  viewMode: Record<string, ViewMode>      // PRD 03
  openFile: (path: string) => void        // dedup by path; sets active
  closeFile: (path: string) => void       // PRD 02 may guard on dirty
  closeOthers: (path: string) => void
  closeAll: () => void
  setActive: (path: string) => void
  setDirty: (path: string, dirty: boolean) => void
  setViewMode: (path: string, mode: ViewMode) => void
}
```

`openFile` derives `name` from the basename. Dedups: re-opening an already-open path just
re-activates it. Closing the active file activates the neighbor (right, else left, else null).

## Navigation bridge

`FileTree` lives in the sidebar; navigation state (`activeNav`) lives in `App`. Wire:

- `AlmanacSidebar` gets a new prop `onOpenFile?: (path: string) => void` (default supplied by
  `App`). `App` passes `(path) => { useEditor.getState().openFile(path); navigate('editor') }`.
- `FilesMode` forwards it to `<FileTree onPreviewFile={onOpenFile} />`.

(Terminal-link integration is PRD 04; this PRD only wires the Files tree.)

## EditorView layout

```
┌ FileTabBar (reuse existing src/renderer/components/layout/FileTabBar.tsx) ┐
│  file-a.md ·  file-b.ts •  file-c.html                                    │
├───────────────────────────────────────────────────────────────────────┤
│  content host — for now: existing DocumentViewer read-only preview       │
│  (PRD 02 swaps in Monaco edit; PRD 03 adds preview toggle)               │
└───────────────────────────────────────────────────────────────────────┘
```

- Reuse `FileTabBar` (props: `openFiles`, `activeFilePath`, `onSelectFile`, `onCloseFile`,
  `onCloseOthers`, `onCloseAll`) wired to the store.
- Content host renders the active file. In this PRD it may delegate to the existing
  `DocumentViewer` to prove the end-to-end open flow; PRD 02/03 replace the body.
- Empty state when `openFiles.length === 0`: "Open a file from the Files sidebar."

## Acceptance criteria

1. Switching the sidebar to **Files** and clicking a previewable file (e.g. a `.md`)
   navigates the main-space to the Editor scene and shows that file.
2. Opening a second file adds a second tab; the strip shows both; clicking a tab switches.
3. Closing a tab removes it and activates a neighbor; closing the last tab shows the empty
   state (scene stays mounted).
4. Re-clicking an already-open file in the tree does not duplicate the tab.
5. `npm run typecheck` passes.
6. No new left-nav tab is added; the only nav surface change is the programmatic route.

## Out of scope (later PRDs)

- Editing/saving (02), rendered preview + toggle (03), terminal links + images (04).

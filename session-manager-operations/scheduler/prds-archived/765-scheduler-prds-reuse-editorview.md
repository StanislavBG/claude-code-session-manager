---
title: Scheduler PRD list: open PRDs in the real EditorView instead of the bespoke structured/raw editor
cwd: ~/Projects/session-manager
estimateMinutes: 28
---
# Goal

PRDs (~/.claude/session-manager/scheduled-plans/prds/*.md) are just files on disk, and the app already has a full-featured, reusable file view/edit surface for exactly this: `src/renderer/components/tabs/EditorView.tsx` driven by the `useEditor` zustand store (`src/renderer/state/editor.ts`) — the same one the Projects/File-Explorer tab uses, with Monaco editing, markdown preview/Wysiwyg/split modes, YAML-frontmatter-aware handling (`src/renderer/lib/markdownDoc.ts`), autosave, and Cmd/Ctrl-S save, all backed by `window.api.files.read`/`window.api.files.write` (main-process `files.cjs`, home-dir-scoped, no project-root restriction — already reaches the PRDs directory with zero new IPC). Instead, `src/renderer/components/tabs/plans/SchedulerPrdsView.tsx` reimplements a parallel, bespoke editing experience: clicking a PRD's slug only loads metadata (no viewer opens); a separate "Edit" button swaps the whole panel into an in-place editor with its own toolbar (Save/Cancel/Reset/Run now/Last run log) and a structured-form-vs-raw-Monaco toggle (`StructuredPrdEditor` vs raw `MarkdownEditor`), tracked by ad hoc `editing`/`pendingEditRef` state. Collapse this: clicking a PRD (the card/title, not just the slug) should call `useEditor.getState().openFile(absolutePathToThatPrdMd)` and render `<EditorView />` in place of the current bespoke editor swap — one flow for both viewing and editing, reusing the same component/API the rest of the app already uses for files, with PRD-specific actions (Queue job, Run now, Last run log, delete/archive) staying as row-level actions in the Scheduler tab exactly as today (per explicit user direction: "no need to change the tab, reusing APIs and components 100%").

# Acceptance criteria

- [ ] ## Core functionality
- [ ] In `src/renderer/components/tabs/plans/SchedulerPrdsView.tsx`, clicking a PRD card (the title/row — not just the slug link) calls `useEditor.getState().openFile(absolutePath)` with the PRD's real absolute path (`~/.claude/session-manager/scheduled-plans/prds/<slug>.md`, resolved via the same path-join logic already used elsewhere in this file for the same directory) and the panel renders `<EditorView />` in place of the current in-place editor (the conditional render currently gated on `editing` around line ~533).
- [ ] The now-redundant bespoke editing machinery is removed: `StructuredPrdEditor` component (lines ~792-918), the raw-mode `MarkdownEditor` usage inside SchedulerPrdsView's own editor swap, the `editing` state, `beginEdit()`, `pendingEditRef`, `handleCardEdit()`, and the separate 'Edit' button — opening a PRD (clicking the row) is now the only entry point into edit, matching how EditorView already works everywhere else (view and edit are the same surface, not two flows).
- [ ] PRD-specific actions that are NOT generic file-editing concerns — 'Queue job'/Run now, 'Last run log', delete/archive, lint — remain as row-level buttons on the PRD list card exactly as before this change (verify each still works: queuing, viewing last run log, archiving).
- [ ] The `selectedSlug`/metadata-loading state used elsewhere in the file (e.g. frontmatter display in the card, `parsePrdFile`/`serializePrdFile` from `src/renderer/lib/prdFrontmatter.ts` if still needed for card-level metadata like title/cwd/estimateMinutes shown in the list) is preserved where it serves the LIST view (card metadata) — only the full-body editing path moves to EditorView. Don't break the card list's title/status/edited-time display.
- [ ] ## Interaction / integration
- [ ] Opening a PRD from the Scheduler tab does not navigate away from the Scheduler tab or the PRDs sub-tab — `<EditorView />` renders inline within the existing PRDs pane layout (mirroring how `ProjectsWorkspace.tsx` renders it inline in its own pane), consistent with the user's explicit instruction not to change tabs.
- [ ] Since `useEditor` is a single global store, opening a PRD from the Scheduler tab and separately opening a different file from the Projects/File-Explorer tab must not silently clobber each other's open-file state in a confusing way — verify (by reading `state/editor.ts`) whether `openFile` supports multiple concurrently-open files/tabs or single-active-file, and document the actual behavior in a one-line code comment at the Scheduler-tab call site if it's single-active-file (i.e. opening a PRD while a Projects file is open will replace it in the shared editor store) — that's acceptable, just make it non-surprising.
- [ ] ## Tests
- [ ] Update or replace any existing test that asserted on the old editing flow (search `src/renderer/components/**/__tests__/*SchedulerPrds*` or similar) to reflect the new open-via-EditorView flow.
- [ ] `timeout 300 npm run typecheck` passes.
- [ ] `timeout 300 npx vitest run` (full unit suite) passes.

# Implementation notes

Read ~/Projects/session-manager/plugins/session-manager-dev/skills/develop/standards.md before starting — mandatory Performance/Debugging/API-reuse/TDD/Execution-discipline rules.

This PRD is the direct product of prior research in this repo, summarized here so you don't need to re-derive it:
- Reusable open-a-file API: `src/renderer/state/editor.ts`, `useEditor.getState().openFile(path: string, opts?: {line?, col?})` — a single zustand-store call, exactly as used at `src/renderer/components/tabs/ProjectsWorkspace.tsx:63`.
- The viewer/editor component itself: `src/renderer/components/tabs/EditorView.tsx` (`export function EditorView()`, no props — reads all state from the `useEditor` store). It dispatches by file type; markdown gets Edit/Wysiwyg/Preview/Split modes with YAML-frontmatter-aware handling via `src/renderer/lib/markdownDoc.ts` (`splitFrontmatter`/`joinFrontmatter`). Read/write via `window.api.files.read`/`window.api.files.write` (`src/main/files.cjs`), which is home-dir-scoped only (`assertInsideHome`), not project-root-scoped — PRDs under `~/.claude/session-manager/scheduled-plans/prds/` are already reachable, no new IPC needed.
- Current bespoke flow to remove: `src/renderer/components/tabs/plans/SchedulerPrdsView.tsx` — card list ~line 683-767, slug click `selectSlug()` (~line 388-392, sets `editing=false`), Edit button ~line 756-762 → `handleCardEdit()` (~line 467-474) → `beginEdit()` (~line 358-367)/`pendingEditRef`, editor swap gated on `editing` (~line 533) rendering raw `MarkdownEditor` (~line 593-600) or `StructuredPrdEditor` (~line 792-918, same file). Note: PRD-specific structured frontmatter parsing lives in `src/renderer/lib/prdFrontmatter.ts` (`parsePrdFile`/`serializePrdFile`) — this is separate from `markdownDoc.ts`'s generic frontmatter split used by EditorView's Wysiwyg mode; keep `prdFrontmatter.ts` if the card list still needs it for metadata display, but the full-body edit path no longer needs `StructuredPrdEditor`.
- Line numbers above are from research at authoring time and may have drifted slightly by execution time (other PRDs may land first) — re-read the actual current file before editing; treat line numbers as pointers, not guarantees.
- This PRD depends on nothing from PRD 764 (dead DocumentViewer.tsx deletion) — unrelated files, safe to run independently/in parallel.

# Out of scope

- Adding new file types/modes to EditorView itself
- Changing Queue-job/Run-now/archive/lint button behavior or placement beyond keeping them working
- Building any new modal — EditorView already renders inline, not as a modal, and that's the desired behavior here

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).

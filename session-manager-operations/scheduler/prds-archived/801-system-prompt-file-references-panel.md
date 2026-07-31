---
title: Referenced-files panel above the System Prompt raw editor
cwd: ~/Projects/session-manager
estimateMinutes: 25
---

# Goal

The System Prompt tab (`src/renderer/components/tabs/SystemPrompt.tsx`) currently renders a
CLAUDE.md's `@path` import lines as inert text inside the raw Monaco editor — a user can't tell
at a glance which files are referenced, whether they resolve, or view them without manually
opening each path elsewhere. Add a `ReferencedFilesPanel` component that sits above the
`MarkdownEditor` in that tab, lists every file the active scope's CLAUDE.md references (via the
`config:parse-imports` IPC call added in `800-system-prompt-import-parsing-ipc.md`), shows
top-level details per file, flags broken/missing references, and lets the user expand any entry
inline to view that file's content — read-only for v1. This is the foundation for future
context-management features, so keep the data shape (the `ImportRef[]` from PRD 800) as the
single source of truth the panel renders from, not a UI-side re-derivation.

## Core functionality

- [ ] New component `src/renderer/components/tabs/ReferencedFilesPanel.tsx` that takes
  `activePath: string | null` as a prop, calls `window.api.config.parseImports(activePath)`
  (the bridge added in PRD 800) when `activePath` changes, and renders one row per returned
  `ImportRef`: the file's basename + full path (truncated with a tooltip for long paths,
  matching the existing truncate pattern already used for `activePath` at
  `SystemPrompt.tsx:95`), a size/token-estimate chip (reuse the `chars · ~N tokens` phrasing
  already used in the toolbar at `SystemPrompt.tsx:97-99`), and an exists/broken indicator
- [ ] Each row is expandable/collapsible (click to toggle, chevron affordance) — when expanded,
  it fetches and shows that file's raw text content read-only below the row, using the existing
  `window.api.config.readText(path)` bridge (already used by `useConfig`'s `loadText` — reuse
  the same IPC call rather than adding a new one) rendered in a simple `<pre>`/read-only Monaco
  instance (reuse `MarkdownEditor` with `readOnly` — it already accepts that prop per
  `src/renderer/components/ui/MarkdownEditor.tsx`)
- [ ] Wire `ReferencedFilesPanel` into `src/renderer/components/tabs/SystemPrompt.tsx`, rendered
  between the toolbar and the `MarkdownEditor` (inside the `Panel` children, only in the
  `activePath && file` branch — see lines 128-136), passing the current `activePath`
- [ ] Panel renders nothing (not even an empty box) when there are zero `@`-imports for the
  active file, so files without imports look exactly as they do today

## Edge cases

- [ ] A referenced file that doesn't exist (`ok: false` / `exists: false` in the `ImportRef`)
  renders with a distinct visual treatment (e.g. warning color, "missing" label) instead of
  silently omitting it or matching the healthy-file styling
- [ ] `window.api.config.parseImports` returning `{ ok: false, error }` (e.g. transient IPC
  failure) is surfaced via the existing toast channel (`useToast().show('error', ...)` per this
  project's convention — see CLAUDE.md's "Toast is the user-facing error channel" note) rather
  than thrown or silently swallowed
- [ ] Switching scope (User/Project/Local via `ScopeSwitcher`) or switching the active tab's cwd
  re-fetches the panel's import list for the new `activePath` and collapses any previously
  expanded rows (stale expanded content from a different file must not linger)

## Interaction / integration

- [ ] Confirm the panel does not fight `MarkdownEditor`'s `automaticLayout: true` Monaco option
  — the panel must occupy fixed/measured space above the editor (not overlay it) so Monaco's
  layout recalculation still fills the remaining space correctly
- [ ] The panel's expanded read-only viewer must NOT register itself with `useConfig`'s
  `watchFile`/file-dirty-tracking machinery (it's a read-only peek, not an editable file) — use
  a local component-level fetch + state, not the shared `files` store, to avoid it appearing as
  a "dirty" or "open" file elsewhere in the app

## Tests

- [ ] `src/renderer/components/tabs/__tests__/ReferencedFilesPanel.test.tsx` (new) covering:
  renders one row per `ImportRef`; missing/broken entries get the distinct treatment; clicking a
  row expands it and calls `config.readText` with that row's path; collapsing hides the content
  without re-fetching on re-expand within the same mount (or re-fetches — pick one behavior and
  assert it, whichever is simpler to implement correctly); zero imports renders nothing
- [ ] `timeout 120 npx vitest run src/renderer/components/tabs/__tests__/ReferencedFilesPanel.test.tsx`
  passes
- [ ] `npm run typecheck` passes

# Implementation notes

Depends on `800-system-prompt-import-parsing-ipc.md` landing first — this PRD consumes
`window.api.config.parseImports(path): Promise<{ ok: true; imports: ImportRef[] } | { ok: false; error: string }>`
and the `ImportRef` type it adds to `src/preload/api.d.ts`. If PRD 800 has not yet landed when
this one executes, stop and report that dependency rather than stubbing the IPC call.

Read `src/renderer/components/tabs/SystemPrompt.tsx` in full first (it is short, ~140 lines) —
this PRD only adds one component and one render slot to it, it does not restructure the tab.
Reuse existing pieces rather than inventing new primitives:
- `estimateTokens()` at `SystemPrompt.tsx:14-16` for any client-side token math (the IPC call
  already returns `tokenEstimate` per file so this may not even be needed renderer-side).
- `MarkdownEditor` (`src/renderer/components/ui/MarkdownEditor.tsx`) with `readOnly` for the
  expanded file viewer — don't add a second Monaco wrapper.
- `useToast()` (`src/renderer/state/toast.ts`) for the IPC-failure edge case.
- The existing truncate-with-tooltip styling already applied to `activePath` at
  `SystemPrompt.tsx:95` for long file paths in the panel rows.

Follow this project's established "list+detail" shape (`components/tabs/Skills.tsx` is the
canonical example named in this repo's CLAUDE.md) loosely for the expand/collapse interaction,
though this is a compact inline panel, not a full list+detail tab layout.

## Engineering standards

Before writing any code, read
`/home/bilko/Projects/session-manager/plugins/session-manager-dev/skills/develop/standards.md`
— it has the Performance, Debugging, API-reuse, TDD, and Execution-discipline rules that apply
to this PRD. Every rule in it is mandatory, especially Execution discipline (bounded commands,
verify before done, the finish-protocol sentinel).

# Out of scope

- Editing a referenced file inline (view-only for v1 — editing it means navigating to it as its
  own scope/tab, out of scope here)
- A dedicated "context management" feature beyond this panel (multi-file token budgets,
  reordering imports, etc.) — this PRD only makes references visible/navigable, it does not
  build the broader context-management system this is a foundation for
- Recursive display of a referenced file's own further `@`-imports (PRD 800's `walkImports`
  already recurses server-side and flattens the whole chain into one list — this PRD renders
  that flat list, it does not build a nested/tree UI)

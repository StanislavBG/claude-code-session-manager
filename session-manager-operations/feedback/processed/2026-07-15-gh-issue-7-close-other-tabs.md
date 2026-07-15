---
title: Add a keyboard shortcut (and Close-to-the-Right) to the editor tab bar's existing bulk-close menu
source: GitHub issue gh-issue-7 (https://github.com/StanislavBG/claude-code-session-manager/issues/7)
type: enhancement
severity: low
---

# What happens / what's missing

The issue asks for a "Close All Other Tabs" capability in the document editor, stating as
current behavior: "Users can only close tabs individually by clicking the 'X' on each tab" and
"No bulk tab management actions available".

# Evidence

**The stated current behavior is false.** Verified against the working tree at triage:

- `src/renderer/components/layout/FileTabBar.tsx:81` — `onContextMenu={(e) => handleContext(e, f.path)}`
  — right-click context menu on a tab already exists.
- `src/renderer/components/layout/FileTabBar.tsx:124-130` — a **"Close Others"** menu item,
  already correctly gated on `openFiles.length > 1` (which is the issue's "disable when only
  one tab is open" edge case, already handled).
- `src/renderer/components/layout/FileTabBar.tsx:132-138` — a **"Close All"** menu item.
- `src/renderer/components/tabs/EditorView.tsx:75-76,183-198` — `closeOthers` / `closeAll`
  wired with an unsaved-changes guard: `anyOtherDirty` / `anyDirty` checks route through a
  `confirmClose` modal before closing. This is the issue's "Must Have" AC
  "preserves unsaved changes (prompts user to save before closing if needed)".
- `src/renderer/state/editor.ts:44-45,110-115` — `closeOthers(path)` keyed on full `path`,
  which is the issue's "works correctly when multiple tabs have the same filename but
  different paths" AC.
- `src/renderer/components/layout/FileTabBar.tsx:63` — middle-click (`e.button === 1`) close
  also already exists.

# Triage evaluation (2026-07-15)

**Premise almost entirely WRONG — 4 of 5 "Must Have" acceptance criteria are already shipped**,
including the two non-trivial ones (unsaved-changes guard, path-keyed correctness). The issue
reads as written without opening the editor's tab bar.

Of the issue's Must-Haves, exactly **one** is genuinely missing:
- ❌ Keyboard shortcut (`Ctrl/Cmd+Shift+W`) — no binding exists; a grep for `closeOthers` /
  `closeAll` outside `EditorView.tsx`/`editor.ts` returns nothing, so nothing keyboard-driven
  reaches them.

Of the Nice-to-Haves:
- ❌ "Close Tabs to the Right" — genuinely absent. Small and idiomatic; accept.
- **DECLINE "Undo Close Tab" / "Recently Closed"** — a new persisted history model for a
  feature whose loss is already guarded by the unsaved-changes modal. Cost/benefit doesn't
  justify it; not asked for by any real user report.
- **DECLINE the overflow ("⋯") button** — duplicates the right-click menu that already exists.
  `CLAUDE.md`'s standing guidance is to extend the surface that already owns the data rather
  than ship a parallel UI. The issue itself lists "takes up horizontal space" as the con.
- **DECLINE the Success Metrics section** — "60%+ of users with 10+ tabs use it within 30
  days" is unmeasurable: this project has no usage telemetry (a gap noted separately in the
  2026-07-15 status audit). Don't adopt AC that cannot be evaluated.

This item is therefore ~30 minutes of work, not the epic the 12-point implementation checklist
implies. Sizing it honestly matters more than the feature.

# Suggested direction

One small PRD against the existing surface:
1. Wire `Ctrl/Cmd+Shift+W` → the existing `handleCloseOthers(activeFilePath)` in `EditorView.tsx`,
   routed through the existing `confirmClose` guard (do not bypass it). Follow the project's
   keybindings conventions; verify no conflict with an existing binding.
2. Add a "Close to the Right" item to the existing `FileTabBar` context menu + a
   `closeToTheRight(path)` action in `editor.ts` mirroring `closeOthers`'s path-keyed shape
   and dirty-guard routing.
3. Nothing else in the issue's checklist is in scope.

## RESOLUTION

**Mostly declined as already-shipped; the genuine remainder queued** as PRD
`545-editor-tab-close-shortcut-and-close-right` (2026-07-15). Execution is the scheduler's job now.

The issue's stated current behavior — "users can only close tabs individually", "no bulk tab
management actions available" — is **false against the working tree**. Verified at triage: the
right-click context menu (`FileTabBar.tsx:81`), "Close Others" gated on `openFiles.length > 1`
(`:124-130`), "Close All" (`:132-138`), middle-click close (`:63`), the unsaved-changes guard modal
(`EditorView.tsx:183-198`), and path-keyed correctness for duplicate filenames (`editor.ts:110-115`)
**all already ship**. Four of the issue's five Must-Have AC were already met, including both
non-trivial ones.

Queued (the real gap, ~12 min): the `Ctrl/Cmd+Shift+W` keyboard shortcut, and "Close to the Right".

Declined: undo/recently-closed (a new persisted history model for a loss the dirty-guard already
prevents); the "⋯" overflow button (duplicates the existing right-click menu, and `CLAUDE.md`'s
standing guidance is to extend the surface that owns the data rather than ship a parallel UI); the
success metrics (unmeasurable — this project has no usage telemetry).

Sizing note for the filer: this was a 12-minute change presented as a 12-point implementation
checklist. Verifying the surface before writing the AC would have caught that.

Originating issue: gh-issue-7 — https://github.com/StanislavBG/claude-code-session-manager/issues/7

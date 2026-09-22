# UI Prefs — session-manager

This folder stores small per-project UI state that used to live in scattered `localStorage`
keys — some already cwd-keyed (`sm.fileTree.expanded:${cwd}`, one global key per cwd ever
browsed), some outright global despite holding per-project data (`sm.scheduler.hiddenCompletedSlugs`,
`sm.scheduler.queueFilter` — two different projects reusing the same PRD slug could hide or
filter each other's rows). One file per project keeps this state scoped to the project it
belongs to by construction, instead of by convention.

## Storage layout

```
session-manager-operations/ui-prefs/
  prefs.json   — per-project UI state for this cwd
```

Path helper: `uiPrefsPath(cwd)` in `src/renderer/lib/uiPrefs.ts` —
`<cwd>/session-manager-operations/ui-prefs/prefs.json`.

## Required shape

```ts
{
  fileTreeExpanded?: string[],      // FileTree.tsx — expanded folder paths in the Files sidebar
  hiddenCompletedSlugs?: string[],  // SchedulePanel.tsx — "Clear completed" hides, renderer-side only
  queueFilterStatus?: string,       // SchedulePanel.tsx — the queue's status filter chip
}
```

All fields are optional — a missing field falls back to its component's own default. New fields
may be added here as more per-project UI state migrates off `localStorage` (see
`scripts/check-renderer-storage.cjs`'s ALLOWLIST for what still needs to move).

## Ownership

Sole writer per `src/main/lib/opsOwnership.cjs`'s `OWNERS` table: **`ui-prefs`**. There is no
dedicated main-process module or IPC channel for this namespace — every write goes through the
existing generic `window.api.config.writeJson(uiPrefsPath(cwd), data, 'ui-prefs')` IPC
(`config:write-json`, which already threads a `writer` param to `assertOpsWrite`). `lib/uiPrefs.ts`'s
`writeUiPrefsPatch` serializes writes per cwd so independent field-owners sharing one project's
file (FileTree's `fileTreeExpanded`, SchedulePanel's `hiddenCompletedSlugs` and
`queueFilterStatus`) can't interleave read-modify-write cycles and drop each other's change —
mirrors `lib/uiSettingsPrefs.ts`'s machine-wide equivalent.

## What's deliberately NOT here

Personal view-preferences that aren't project data (nav sub-view, memory-tab scope, the file
tree's hidden-files toggle, and similar) stay in the machine-wide
`~/.claude/session-manager/ui-settings-prefs.json` — see `lib/uiSettingsPrefs.ts`. This namespace
is for state that is genuinely per-project; a keyboard-focus row index (`sm.scheduler.focusedJobIndex`)
isn't project data either — it was dropped rather than migrated (plain `useState` instead).

---
name: page-app-settings
description: Steward of Session Manager's App Settings page (NavKey `app-settings`, Home face). Use to audit, review, or implement any change to that page.
tools: Read, Grep, Glob, Bash, Edit, Write
model: sonnet
effort: medium
title: Page Steward — App Settings
---

You are page-app-settings, the steward of Session Manager's App Settings page.

First read session-manager-operations/architecture/page-stewards.md, then run `node scripts/page-surface.cjs app-settings`.

## Your page

- NavKey: `app-settings`
- Label: App Settings
- Faces: Home
- Entry: `src/renderer/components/tabs/AppSettings.tsx`

Tabs: Voice, Appearance, Telemetry, Phone remote, Updates & retention, Startup, Storage map.

Reads and writes Session Manager's own files, never Claude Code's `settings.json`:
- `~/.claude/session-manager/app-prefs.json`, `ui-chrome-prefs.json`, voice settings
- `telemetry.json`, `otel.json`, `web-remote.json` under `~/.claude/session-manager/`

## Page invariants

- App Settings is the home for the app's own preferences; Claude Code's settings.json belongs to the Settings page.
- Prefs persist to disk through `src/renderer/lib/appPrefs.ts` / `uiSettingsPrefs.ts`, never browser storage
  (`npm run lint:renderer-storage`).
- Telemetry is anonymous, on by default and opt-out (`SM_TELEMETRY=0`); the bilko.run relay stays live (root
  `CLAUDE.md`). The Storage map is the hand-maintained `src/renderer/lib/dataModelErd.ts`, changed in the same commit
  as the shapes it mirrors.
- 'Start at login' (Startup tab, `SettingsStartAtLogin.tsx`) reads and writes the system's own login item through
  `window.api.loginItem` and has no preference file; it re-reads `loginItem.status()` every time the tab opens.
- A tab can be pre-selected by `openPanel('app-settings', '<tab>')` (`usePanelTabHint` in `src/renderer/state/layout.ts`).

## Boundaries

The shared steward rules apply, with `<key>` = `app-settings`: [page-stewards.md#boundaries](../../session-manager-operations/architecture/page-stewards.md#boundaries).

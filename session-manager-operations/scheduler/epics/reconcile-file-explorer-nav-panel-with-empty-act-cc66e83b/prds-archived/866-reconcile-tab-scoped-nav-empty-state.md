---
title: Reconcile File Explorer nav panel with empty active-tab state
cwd: /home/bilko/Projects/session-manager
estimateMinutes: 15
---
# Goal

Fix a reachable broken UI state: the 'projects' NavKey (labeled "File Explorer" in AlmanacSidebar, rendered by `src/renderer/components/tabs/ProjectsWorkspace.tsx`) reads `activeTab` from `useSessions()` (session Terminal tabs) and shows a dead-end "No session selected." message (ProjectsWorkspace.tsx:210-212) whenever `activeTabId` is null while `focusedPanelId` (src/renderer/state/layout.ts) is `'projects'`. This is reachable today: `activeTabId` can legitimately become null (last tab closed, or `App.tsx`'s explicit `useSessions.setState({ activeTabId: null })` calls at lines 67 and 184 when navigating to `'terminal'` / starting a new project) while `focusedPanelId` stays wherever it was — there is currently no reconciliation between the two independent zustand stores (`useSessions().activeTabId` and `useLayout().focusedPanelId`). Confirmed via a real screenshot at `session-manager-operations/prompt-sessions/attachments/82ppe8fyl4i-image.png`: File Explorer nav panel selected, sidebar shows "no session", main pane shows "No session selected." — a dead end with no path back to a working screen. Fix this by making 'overview' (Home) the reconciliation target: whenever `focusedPanelId === 'projects'` and `activeTabId` is or becomes null, auto-navigate back to `'overview'` via the existing `useLayout.getState().openPanel('overview')` routing path, so the user always lands somewhere functional instead of a dead panel. Do NOT apply this guard to `'terminal'` (Epics workspace intentionally renders with `activeTabId === null` — see App.tsx:62-69 comment) or to `'browser'`/`'editor'` (each owns its own independent tab-id state, not session `activeTabId` — confirmed by grep, `Browser.tsx` uses `useBrowserState().activeTabId` and `EditorView.tsx` has no `activeTab` dependency at all). Also confirm Home is the correct boot-time fallback: `useLayout`'s `focusedPanelId` already defaults to `DEFAULT_LAYOUT[0]` which resolves to `'overview'` (first entry in `SCREEN_KEYS`, src/renderer/lib/screenKeys.ts:16) — verify this stays true and isn't overridden by any hydration path, so "Home is the permanent starting panel when nothing else exists" holds both on cold boot and after this reconciliation fix.

# Acceptance criteria

- [ ] A reconciliation effect exists (in App.tsx, alongside the existing activeTabId-watching useEffect at lines ~104-116, or in a small dedicated hook) that calls `useLayout.getState().openPanel('overview')` when `focusedPanelId === 'projects'` and `activeTabId` is null — verified either becoming null while already on 'projects', or already null when 'projects' is opened.
- [ ] The guard is scoped ONLY to 'projects' — add a short comment naming why 'terminal' is excluded (Epics workspace's intentional null-tab render) and confirming 'browser'/'editor' don't need it (independent tab-id stores), so a future NavKey addition doesn't get silently swept into or excluded from the guard without a deliberate decision.
- [ ] Manual verification: close all session tabs while File Explorer ('projects') is focused (or open File Explorer with zero tabs open) — main pane lands on the Home/overview panel, never shows 'No session selected.' Capture a screenshot proving this (before/after vs the attached bug screenshot) using the project's existing screenshot tooling per the `run` skill if available, otherwise describe the manual repro steps taken.
- [ ] `timeout 120 npm run typecheck` passes.
- [ ] `timeout 300 npx vitest run src/renderer/state/__tests__/layout.test.ts` passes, plus a new or extended test in that file (or a new `App`-level test if one exists) covering the reconciliation behavior: focusedPanelId flips to 'projects' with activeTabId null → reconciles to 'overview'; focusedPanelId 'terminal' with activeTabId null does NOT reconcile.
- [ ] No regression to the existing pure-tab-switch effect (App.tsx:104-116) that opens 'terminal' when switching between two already-open tabs — re-verify that behavior still works (existing test coverage if present, or manual note).

# Implementation notes

Read `session-manager-operations/scheduler/PRD_AUTHORING.md`-referenced standards file first: `/home/bilko/Projects/session-manager/plugins/session-manager-dev/skills/develop/standards.md` (resolve relative to wherever this PRD's authoring skill lives — if that exact path doesn't exist on this machine, search `plugins/session-manager-dev/skills/develop/standards.md` under the repo root). Key files: `src/renderer/App.tsx` (activeTabId at line 90, activeTab derivation line 92, focusedPanelId line 50, navigate() callback lines 62-69, existing tab-switch reconciliation effect lines 104-116); `src/renderer/state/layout.ts` (`useLayout` store, `openPanel`/`focusPanel`, `focusedPanelId` default at line 69); `src/renderer/state/sessions.ts` (`useSessions` store, `activeTabId`); `src/renderer/components/tabs/ProjectsWorkspace.tsx` (lines 200-213, the broken empty state — do not need to change this file's own rendering, the fix is upstream reconciliation, but you may also improve its empty-state copy/CTA as a small bonus if time allows, not required); `src/renderer/lib/screenKeys.ts` (SCREEN_KEYS order, 'overview' is index 0). Pattern to follow: this is the same shape as the existing `useEffect` at App.tsx:104-116 that watches `[activeTabId, tabs]` and calls `useLayout.getState().openPanel(...)` — add a sibling effect (or extend that one) watching `[activeTabId, focusedPanelId]`.

# Out of scope

- Persisting focusedPanelId across app restarts — out of scope for this PRD; current always-reset-to-Home-on-boot behavior is correct per the ask ("Home tab is permanent and should be the starting tab if nothing else exists") and Terminal-tab resume already works via activeTabId persistence (sessions.ts) — do not touch that.
- Redesigning ProjectsWorkspace's empty-state UI/copy — optional bonus only, not required AC.
- Adding the guard to any NavKey other than 'projects' without first confirming (by reading that component's source) it actually depends on session activeTabId the same way.

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).

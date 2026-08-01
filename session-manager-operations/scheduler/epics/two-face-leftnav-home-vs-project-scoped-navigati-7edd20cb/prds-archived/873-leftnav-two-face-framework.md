---
title: "Two-Face LeftNav framework: NavFace type + per-item face registry"
cwd: /home/bilko/Projects/session-manager
estimateMinutes: 25
sourcePromptId: two-face-leftnav-home-vs-project-scoped-navigati-7edd20cb
---
# Goal

Introduce a NavFace concept ('home' | 'project') so the sidebar can render two different item
sets depending on whether the Home tab (focusedPanelId === 'overview') or a project/session tab
is focused. This is purely additive infrastructure — no nav item is removed from the app, each
item is just tagged with which face(s) it belongs to. Individual tabs' internal
default-scope/default-filter behavior is NOT changed by this PRD; that is deliberately split
into separate sibling PRDs (874-895 in this same epic's prds dir) so this foundational PRD stays
small and lands first. All sibling PRDs declare `dependsOn: [leftnav-two-face-framework]`, so do
not wait for them or duplicate their work.

# Acceptance criteria

- [ ] New file `src/renderer/lib/navFace.ts` exports `type NavFace = 'home' | 'project'` and
      `deriveNavFace(focusedPanelId: string | null, hasActiveTab: boolean): NavFace` — returns
      'home' when focusedPanelId === 'overview' OR hasActiveTab is false, else 'project'
- [ ] In `src/renderer/lib/navGroups.ts`, the NavItem type gains a `faces: NavFace[]` field;
      every existing entry in NAV_ITEMS (currently ~lines 27-53) is tagged: home-only — browser,
      plugins, keybindings, remote, sm-config, voice; project-only — project-home, projects,
      repoviz, search, memory; both (`['home','project']`) — terminal, scheduler, history,
      system-prompt, skills, mcp, hooks, permissions, settings
- [ ] navGroups.ts exports `getNavItemsForFace(face: NavFace): NavItem[]` filtering NAV_ITEMS by
      the faces tag, preserving existing group order (Workspace/Configure/Tools)
- [ ] `src/renderer/components/layout/AlmanacSidebar.tsx` computes navFace via
      `deriveNavFace(active, !!activeTab)` (activeTab already resolved there from useSessions)
      and filters each nav group through `getNavItemsForFace(navFace)` before rendering,
      replacing the current unfiltered NAV_ITEMS usage
- [ ] When navFace === 'home', AlmanacSidebar renders a lightweight machine-level header in
      place of the current ProjectCaption (~lines 270-344) — reuse the existing
      "Open / Start Project" button, but do not show a specific tab's cwd/branch since none is
      focused; SidebarFooter (~lines 461-498) hides the model/preset chip when navFace ===
      'home' (activeTab may be undefined) but keeps the recording indicator if isRecording
- [ ] New unit test `src/renderer/lib/__tests__/navFace.spec.ts` covers deriveNavFace: overview
      panel -> 'home'; non-overview panel with an active tab -> 'project'; non-overview panel
      with no active tab -> 'home'
- [ ] New/updated unit test asserts getNavItemsForFace('home') and getNavItemsForFace('project')
      each return the exact expected key sets per the classification above
- [ ] timeout 300 npm run typecheck passes with zero errors
- [ ] timeout 120 npx vitest run src/renderer/lib/__tests__/navFace.spec.ts (and any
      updated navGroups test) passes
- [ ] npm run lint:selectors passes

# Implementation notes

Read src/renderer/lib/navGroups.ts and src/renderer/components/layout/AlmanacSidebar.tsx in
full first — do not guess the NavItem shape. AlmanacSidebar's activeTab is resolved via
useSessions(); the sidebar's `active` prop (NavKey | null) is what App.tsx passes as
focusedPanelId from useLayout(). Do not touch CommandPalette.tsx in this PRD — its nav entries
stay face-agnostic for now (a known follow-up, out of scope here). Do not change any dual-scope
tab's internal default-scope logic (Settings.tsx, Hooks.tsx, etc.) — that is explicitly out of
scope, handled by sibling PRDs. Check if src/renderer/testUtils/ (currently untracked in git
status) already has a mounting/mocking harness for useSessions/useLayout before writing test
scaffolding from scratch. This repo uses vitest, not `node --test`. Commit only the files this
PRD actually changes — do not `git add -A`, since other uncommitted local changes may exist in
the working tree.

# Out of scope

- Per-tab default-scope/default-filter behavior (handled by sibling PRDs 874-895)
- CommandPalette.tsx nav-entry face filtering

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).

---
title: Project Home nav scaffold — NavKey, sidebar row swap, fixed TabBar Home chip
cwd: ~/Projects/session-manager
estimateMinutes: 12
sourcePromptId: home-redesign-global-machine-home-per-project-br-fa12799f
---

# Goal

Wire the new per-project Home ("The Brief") into the shell per the design decision in `/home/bilko/Projects/session-manager/session-manager-operations/design-mocks/home/DESIGN_SPEC.md` ("Mapping onto the real app"): add NavKey `project-home` rendering a new `ProjectHome` component (scaffold with header + empty states only — later PRDs fill the blocks), make it the FIRST Workspace sidebar row labeled "Home", remove the `overview` sidebar row, and add the mock's fixed, always-leftmost machine-Home chip to `TabBar.tsx` that navigates to `overview`. `overview` stays the boot-default panel and keeps its existing Home (machine-wide) screen.

# Acceptance criteria

## Core functionality

- [ ] `project-home` added to the `NavKey` union (`src/renderer/components/LeftNav.tsx`), to `SCREEN_KEYS` (`src/renderer/lib/screenKeys.ts`), and to the screen registry switch in `src/renderer/components/screenComponents.tsx`, rendering the new `src/renderer/components/tabs/projecthome/ProjectHome.tsx`.
- [ ] `lib/navGroups.ts`: the `overview` row is replaced by `{ key: 'project-home', group: 'Workspace', label: 'Home', icon: 'home', hint: 'What this project is, and what is in flight' }` as the first Workspace item; the file's header comment about no-sidebar-row keys now names `overview`; the removal guard exits 0: `if grep -q "key: 'overview'" src/renderer/lib/navGroups.ts; then echo LEFTOVER && exit 1; else echo clean; fi`.
- [ ] `TabBar.tsx` renders a fixed home-icon chip (AlmanacIcon `home`) BEFORE all project tabs, followed by a 1px `bg-line` vertical divider; clicking it focuses the `overview` panel (use the same navigation path the sidebar uses — read how `AlmanacSidebar` dispatches nav and reuse it, e.g. via a prop from `App.tsx` or the layout store); when `useLayout((s) => s.focusedPanelId) === 'overview'` the chip shows active styling (`bg-bg` + a 2px inset accent top bar per the mock); it has no close button and is not a SessionTab.
- [ ] `ProjectHome.tsx` scaffold: resolves the active project via `useSessions` activeTabId → tab.cwd; with NO active tab renders `ui/EmptyState` ("Open a project to see its brief"); with a tab renders a header card with the project name (last cwd segment) and a placeholder body — enough to prove routing.

## Interaction / integration

- [ ] `CommandPalette.tsx` nav entries stay unambiguous: the machine home (`overview`) entry reads "Home — this machine" and `project-home` picks up its navGroups label; both navigate correctly.
- [ ] `AlmanacFooter.tsx`'s Home-pill navigation target still resolves (it navigates to `overview`); boot default `focusedPanelId` stays `overview` (`state/layout.ts` — verify, don't change).
- [ ] Grep-check remaining `overview` consumers (`grep -rn "'overview'" src/renderer --include='*.tsx' --include='*.ts'`) and fix any spot that assumed `overview` has a sidebar row (e.g. eyebrow lookup via `NAV_GROUP_BY_KEY` must tolerate undefined — it is `Partial<>` already; tour overlay references if any).

## Tests

- [ ] A vitest spec `src/renderer/lib/__tests__/navGroupsHome.test.ts` asserts: first Workspace item key is `project-home` with label "Home", and no NAV_ITEMS entry has key `overview`.
- [ ] `timeout 120 npm run lint:selectors` passes; `timeout 300 npm run typecheck` passes.

# Out of scope

- Any Brief content blocks or `projectBrief` IPC consumption (PRDs 839/840 — this scaffold must not import `window.api.projectBrief`).
- Redesigning the machine Home content (PRDs 835/836 own `Home.tsx`; do not edit it here beyond nothing).
- Nav rows other than the Home swap (History stays; no "Usage" row from the mock).

# Implementation notes

Read the DESIGN_SPEC.md mapping section first. `TabBar.tsx` header comment documents the zustand selector trap — follow it (per-slice subscriptions, no fresh values in selectors). `screenComponents.tsx:78` shows how `overview` mounts `Home` — mirror that shape for `project-home`. The mock reference for the chip is `home-shell-mock.jsx` (`HsTabStrip`'s leftmost button) in the same design-mocks/home/ folder; translate styles to Tailwind tokens. This PRD is independent of 835/836/837 and may run in parallel (it does not edit `Home.tsx`; the palette label tweak lives in `CommandPalette.tsx`/nav data, not Home).

## Engineering standards

Before writing any code, read `/home/bilko/Projects/session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging, API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is mandatory, especially Execution discipline (bounded commands, verify before done, the finish-protocol sentinel).

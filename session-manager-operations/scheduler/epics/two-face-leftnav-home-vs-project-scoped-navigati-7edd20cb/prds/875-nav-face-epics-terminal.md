---
title: "Nav face: Epics/Terminal both-face with home=all-projects, project=cwd-scoped default"
cwd: /home/bilko/Projects/session-manager
estimateMinutes: 20
sourcePromptId: two-face-leftnav-home-vs-project-scoped-navigati-7edd20cb
dependsOn: [leftnav-two-face-framework]
---
# Goal

Make the Epics/Terminal nav destination (key `terminal` in NAV_ITEMS, component
`src/renderer/components/epics/EpicsWorkspace.tsx`, hosted always-on via
`src/renderer/components/TerminalStage.tsx`) default its project filter based on the NavFace
landed by `leftnav-two-face-framework`: Home face shows Epics across all projects (current
default, unchanged), Project face defaults to filtering to the active tab's cwd. EpicsWorkspace
accepts an optional `cwd` prop but TerminalStage currently mounts it once with no prop
(always-on singleton) — so the default must be an internal state default that reacts to navFace
changes, not a mount-time prop, and must not clobber a filter the user picked manually.

# Acceptance criteria

- [ ] Confirm/add `faces: ['home','project']` for the `terminal` key in
      `src/renderer/lib/navGroups.ts` NAV_ITEMS
- [ ] EpicsWorkspace.tsx computes navFace via `deriveNavFace` (from
      `src/renderer/lib/navFace.ts`) using `useLayout()`'s focusedPanelId and `useSessions()`'s
      active-tab presence
- [ ] When navFace transitions to 'project' and the user has not manually changed the project
      filter since the last transition (track via a ref/flag set inside the existing
      filter-change handler), the internal filter auto-defaults to the active tab's cwd; when
      navFace transitions to 'home' with no manual touch, it resets to "all projects"
- [ ] A manual filter change by the user is never overridden by a subsequent re-render at the
      same navFace value (only an actual face transition re-applies the default)
- [ ] New unit test covers: initial mount at navFace='home' -> filter is 'all'; navFace flips to
      'project' with a cwd -> filter becomes that cwd; user manually sets a different filter,
      then a re-render at the same navFace does not reset it
- [ ] timeout 300 npm run typecheck passes
- [ ] timeout 120 npx vitest run <the new/updated EpicsWorkspace test file> passes

# Implementation notes

Read EpicsWorkspace.tsx (~lines 31-34, 159-160) and TerminalStage.tsx (~line 47, mounts
`<EpicsWorkspace />` with no cwd prop, always-on singleton) before changing anything — do not
change TerminalStage's mount to pass a prop; the fix belongs inside EpicsWorkspace's own state
derivation since it is never remounted. Depends on leftnav-two-face-framework's navFace.ts and
getNavItemsForFace(); read that file's current state, don't recreate it.

# Out of scope

- Changing TerminalStage's mount signature
- Any Epics list/filter UI redesign beyond the default-value derivation

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).

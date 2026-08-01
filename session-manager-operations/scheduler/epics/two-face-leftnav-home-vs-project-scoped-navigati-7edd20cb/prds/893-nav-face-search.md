---
title: "Nav face: tag Search as project-only"
cwd: /home/bilko/Projects/session-manager
estimateMinutes: 10
sourcePromptId: two-face-leftnav-home-vs-project-scoped-navigati-7edd20cb
dependsOn: [leftnav-two-face-framework]
---
# Goal

Confirm the 'search' nav destination (`src/renderer/components/modals/SearchModal.tsx`, searches
"across the active cwd" per its intro text in `screenComponents.tsx` ~line 66) is tagged
project-only in the two-face registry landed by `leftnav-two-face-framework`, and add a
regression test. This is distinct from the Cmd-K CommandPalette (out of scope for this whole
epic, per leftnav-two-face-framework's notes) — do not conflate the two.

# Acceptance criteria

- [ ] Confirm `faces: ['project']` for the `search` key in `src/renderer/lib/navGroups.ts`
      NAV_ITEMS (added by leftnav-two-face-framework; add if missing)
- [ ] Grep SearchModal.tsx to confirm it already requires a resolvable `activeTab.cwd` to
      search (guaranteed by Project face); if it crashes on a null cwd, add a guard as the only
      additional change
- [ ] New/updated unit test asserts `getNavItemsForFace('home')` excludes `search` and
      `getNavItemsForFace('project')` includes it
- [ ] timeout 300 npm run typecheck passes
- [ ] timeout 120 npx vitest run <the updated test file> passes

# Implementation notes

Depends on leftnav-two-face-framework's navFace.ts / faces field / getNavItemsForFace — read
current state of navGroups.ts first. Do not touch CommandPalette.tsx (Cmd-K) — it is a separate
surface, explicitly out of scope for this entire epic.

# Out of scope

- CommandPalette.tsx (Cmd-K) changes
- Search feature changes beyond the face tag and a null-cwd guard if genuinely missing

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).

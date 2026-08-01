---
title: "Nav face: tag Repo Viz as project-only"
cwd: /home/bilko/Projects/session-manager
estimateMinutes: 10
sourcePromptId: two-face-leftnav-home-vs-project-scoped-navigati-7edd20cb
---
# Goal

Confirm the 'repoviz' nav destination
(`src/renderer/components/modals/RepoVisualizationModal.tsx`, a language/dir map of "the current
project" per its intro text in `screenComponents.tsx` ~line 65) is tagged project-only in the
two-face registry landed by `leftnav-two-face-framework`, and add a regression test.

# Acceptance criteria

- [ ] Confirm `faces: ['project']` for the `repoviz` key in `src/renderer/lib/navGroups.ts`
      NAV_ITEMS (added by leftnav-two-face-framework; add if missing)
- [ ] Grep RepoVisualizationModal.tsx to confirm it already requires a resolvable
      `activeTab.cwd` to render (guaranteed by Project face); if it crashes on a null cwd, add a
      guard as the only additional change
- [ ] New/updated unit test asserts `getNavItemsForFace('home')` excludes `repoviz` and
      `getNavItemsForFace('project')` includes it
- [ ] timeout 300 npm run typecheck passes
- [ ] timeout 120 npx vitest run <the updated test file> passes

# Implementation notes

Depends on leftnav-two-face-framework's navFace.ts / faces field / getNavItemsForFace — read
current state of navGroups.ts first.

# Out of scope

- Repo Viz feature changes beyond the face tag and a null-cwd guard if genuinely missing

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).

---
title: "Nav face: tag File Explorer as project-only"
cwd: /home/bilko/Projects/session-manager
estimateMinutes: 10
sourcePromptId: two-face-leftnav-home-vs-project-scoped-navigati-7edd20cb
---
# Goal

Confirm the 'projects' (File Explorer) nav destination
(`src/renderer/components/tabs/ProjectsWorkspace.tsx`) is tagged project-only in the two-face
registry landed by `leftnav-two-face-framework`, and add a regression test. It already
hard-depends on activeTab and shows a "No session selected" empty state (~lines 32-34, 142,
200-202) — no component change expected.

# Acceptance criteria

- [ ] Confirm `faces: ['project']` for the `projects` key in `src/renderer/lib/navGroups.ts`
      NAV_ITEMS (added by leftnav-two-face-framework; add if missing)
- [ ] New/updated unit test asserts `getNavItemsForFace('home')` excludes `projects` and
      `getNavItemsForFace('project')` includes it
- [ ] Grep `state/layout.ts`'s `needsProjectsPanelReconciliation` to confirm it still behaves
      correctly with the new face filtering — no change expected; note findings in the commit
      message if a gap is found rather than silently leaving it
- [ ] timeout 300 npm run typecheck passes
- [ ] timeout 120 npx vitest run <the updated test file> passes

# Implementation notes

Depends on leftnav-two-face-framework. Do not redesign ProjectsWorkspace's empty state; it
already handles no-activeTab gracefully.

# Out of scope

- ProjectsWorkspace empty-state redesign

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).

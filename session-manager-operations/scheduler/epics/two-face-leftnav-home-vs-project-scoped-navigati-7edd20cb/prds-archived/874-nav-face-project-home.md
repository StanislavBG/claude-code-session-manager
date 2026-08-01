---
title: "Nav face: tag Project Home as project-only, verify no home-face render path"
cwd: /home/bilko/Projects/session-manager
estimateMinutes: 12
sourcePromptId: two-face-leftnav-home-vs-project-scoped-navigati-7edd20cb
---
# Goal

Confirm and lock in that the 'project-home' nav destination
(`src/renderer/components/tabs/projecthome/ProjectHome.tsx`) is project-only in the two-face
sidebar landed by `leftnav-two-face-framework` (which added `faces` tagging to NAV_ITEMS in
`src/renderer/lib/navGroups.ts` and `getNavItemsForFace()`). This is a verification +
regression-test PRD, not a new-feature PRD — ProjectHome already hard-depends on
`activeTab?.cwd` (~lines 483-494), so no component code change is expected; the job is to add
the regression test that keeps it that way.

# Acceptance criteria

- [ ] Confirm in `src/renderer/lib/navGroups.ts` that the NAV_ITEMS entry for key
      `project-home` has `faces: ['project']` (added by leftnav-two-face-framework — add it if
      missing)
- [ ] New/updated unit test asserts `getNavItemsForFace('home')` does NOT include the
      `project-home` key and `getNavItemsForFace('project')` DOES include it
- [ ] Grep ProjectHome.tsx to confirm it still reads cwd from activeTab and has a graceful
      empty/no-session state; if it crashes on a null cwd, fix the guard as the only code change
- [ ] timeout 300 npm run typecheck passes
- [ ] timeout 120 npx vitest run <the updated/new test file path> passes

# Implementation notes

This PRD depends on leftnav-two-face-framework having already landed navFace.ts, the `faces`
field on NavItem, and `getNavItemsForFace()` in src/renderer/lib/navGroups.ts — read that file's
current state first rather than assuming it doesn't exist yet. Keep this PRD small; it is a
tagging + regression-test PRD, not a redesign of ProjectHome.

# Out of scope

- Any ProjectHome feature work beyond a null-cwd guard if one is genuinely missing

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).

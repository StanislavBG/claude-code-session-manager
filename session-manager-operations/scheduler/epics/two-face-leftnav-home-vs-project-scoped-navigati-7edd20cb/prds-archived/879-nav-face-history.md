---
title: "Nav face: History both-face with home=all-projects, project=isolate-to-this-project default"
cwd: /home/bilko/Projects/session-manager
estimateMinutes: 18
sourcePromptId: two-face-leftnav-home-vs-project-scoped-navigati-7edd20cb
---
# Goal

Wire the History tab's existing per-project facet/filter
(`src/renderer/components/tabs/HistoryDashboard.tsx`, `projectRows`, `toggleProject`,
`isolateProject`, ~lines 74-238) to default from the NavFace landed by
`leftnav-two-face-framework`: Home face shows all projects (current default, unchanged), Project
face calls the existing `isolateProject(activeTab.cwd)` on mount/face-transition. History stays
analytics/cost/charts-only per existing project convention — do not add session search/preview/
resume features.

# Acceptance criteria

- [ ] Confirm/add `faces: ['home','project']` for the `history` key in
      `src/renderer/lib/navGroups.ts` NAV_ITEMS
- [ ] HistoryDashboard.tsx computes navFace via `deriveNavFace`; on a face transition to
      'project' with a resolvable active-tab cwd and no manual filter touch since the last
      transition, it calls the existing `isolateProject` for that cwd; on a transition to 'home'
      with no manual touch, it clears the isolation back to all-projects
- [ ] A manual project-filter change by the user survives re-renders at the same navFace
- [ ] New unit test: mount at navFace='home' -> all projects shown; navFace flips to 'project'
      with a cwd -> that project is isolated; manual filter change is not reset by a same-face
      re-render
- [ ] timeout 300 npm run typecheck passes
- [ ] timeout 120 npx vitest run <the new/updated HistoryDashboard test file> passes

# Implementation notes

Depends on leftnav-two-face-framework's navFace.ts. Reuse the same
auto-default-unless-manually-touched pattern as sibling PRDs 875 and 878 — a ref flag set inside
the existing filter-change handler is sufficient. Do not add session search/preview/resume to
History; it stays analytics/cost/charts-only by existing project convention.

# Out of scope

- Session search/preview/resume in History (explicitly not this tab's scope)

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).

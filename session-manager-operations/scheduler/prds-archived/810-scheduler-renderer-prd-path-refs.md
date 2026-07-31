---
title: Scheduler: update renderer PRD path references to per-project locations
cwd: ~/Projects/session-manager
estimateMinutes: 15
---

# Goal

PRD 3 of the 808→809→810→811 chain. Update renderer-side PRD path references —
`src/renderer/components/SchedulePanel.tsx`, `src/renderer/components/tabs/plans/SchedulerPrdsView.tsx`,
`src/renderer/components/tabs/Scheduler.tsx`, `src/renderer/components/TourOverlay.tsx`,
`src/renderer/components/learningContent.ts` — to reflect the new per-project
`session-manager-operations/scheduler/prds/` storage instead of the old global
`~/.claude/session-manager/scheduled-plans/prds/` path, wherever this path is shown to the user
(tooltips, help text, empty states, onboarding copy) or used to construct/parse a displayed file
path. This is display/parsing-copy only — no new renderer logic to discover files across
projects; the main process (post PRD 808/809) already exposes discovered PRDs over existing IPC.

# Acceptance criteria

- [ ] Grep each of `src/renderer/components/SchedulePanel.tsx`,
  `src/renderer/components/tabs/plans/SchedulerPrdsView.tsx`,
  `src/renderer/components/tabs/Scheduler.tsx`, `src/renderer/components/TourOverlay.tsx`,
  `src/renderer/components/learningContent.ts` for literal `scheduled-plans` or
  `~/.claude/session-manager` text and update any user-facing copy or path-construction logic
  to the new convention — prefer deriving the displayed path from the live IPC payload (see
  `scheduler.cjs`'s `payload.paths = { root, prds, runs, queue }`, currently ~line 983) over
  hardcoding a new literal string in the renderer.
- [ ] `src/renderer/lib/__tests__/browserExport.test.ts` updated if it asserts on the old path
  string.
- [ ] `timeout 120 npx vitest run src/renderer/lib/__tests__/browserExport.test.ts` passes.
- [ ] `timeout 300 npm run typecheck` passes.

# Implementation notes

Depends on PRDs 808 and 809 having landed the main-process path changes first. Confirm the IPC
`paths` payload shape `scheduler.cjs` actually emits post-migration before wiring renderer
consumers to it — it may now need to be a list keyed by project rather than one flat object,
since PRDs no longer live under a single root. If the payload shape changed in 808/809, read the
actual emitted shape rather than assuming the pre-migration `{ root, prds, runs, queue }` shape
still applies.

# Out of scope

- Any new main-process logic (808/809 already landed)
- Docs/skill file updates (PRD 811)
- Building new cross-project renderer UI beyond updating existing path references

## Engineering standards

Before writing any code, read
`/home/bilko/Projects/session-manager/plugins/session-manager-dev/skills/develop/standards.md`
— it has the Performance, Debugging, API-reuse, TDD, and Execution-discipline rules that apply
to this PRD. Every rule in it is mandatory, especially Execution discipline (bounded commands,
verify before done, the finish-protocol sentinel).

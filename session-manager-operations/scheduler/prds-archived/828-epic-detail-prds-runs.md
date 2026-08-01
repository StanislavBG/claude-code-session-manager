---
title: Epics redesign 7/8 — EpicDetail PRDs + Runs tabs
cwd: ~/Projects/session-manager
estimateMinutes: 15
sourcePromptId: implement-the-redesigned-two-pane-epics-workspac-7781682f
---

# Goal

Fill in the PRDs and Runs tab panels of `src/renderer/components/epics/EpicDetail.tsx`
(shell + Discussion landed in PRD 827-epic-detail-discussion — read the component as actually
landed first). Spec: `session-manager-operations/design-mocks/epics/DESIGN_SPEC.md` (§"Right
pane", PRDs/Runs bullets); mock: `epics-mock.jsx` (PrdList and the runs view).

# Acceptance criteria

## Core functionality

- [ ] PRDs tab: one card per entry from `epicPrds(epicId, snapshots)`
  (`src/renderer/lib/epicDerive.ts`, PRD 826): file icon, mono slug/filename, status pill
  (reuse `PrdStatusPill`/`STATUS_TONE` from
  `src/renderer/components/tabs/scheduler/sched-primitives.tsx` — do not fork a new pill),
  title when present, and an open affordance that navigates to the Scheduler PRD view via the
  existing `openPrdSlug` mechanism (`TerminalChat.tsx:175` — import it from wherever PRD 827
  left it). Footer caption: "Accepting a PRD hands it to the Scheduler as a `claude -p` job."
- [ ] Runs tab: one card per schedule job with `sourcePromptId === epicId` (from
  `useScheduleState` jobs snapshot): slug, status pill, startedAt/finishedAt ages, runtime,
  exit/verdict when present (`ScheduleJob` fields in `src/preload/api.d.ts:376`), and — when
  `runId` exists — a "View log" affordance using the existing run-log viewer pattern
  (`components/tabs/plans/RunLogViewer.tsx` / `window.api.schedule.readLog(runId, slug)`);
  reuse, don't re-implement.
- [ ] Tab labels ("PRDs N", "Runs N") show live counts from the same joins.

## Edge cases

- [ ] Empty states per the mock: dashed card "No PRD yet for this Epic. Ask Claude in the
  thread — it will attach here." and "No agent runs in this Epic yet."
- [ ] A PRD file with no job row shows status "draft"; a job whose PRD file was archived
  still lists (job row is the source).

## Tests

- [ ] vitest jsdom tests: PRD card join (file-only → draft; file+job → job status), Runs
  list filtering by sourcePromptId, empty states, live tab counts. `timeout 300 npx vitest
  run <new files>` passes; `timeout 300 npm run typecheck` and `npm run lint:selectors` pass.

# Implementation notes

Serial after 827-epic-detail-discussion (same file). `epicPrds` needs
`window.api.schedule.listPrds()` results — fetch once at the workspace/container level and
pass down as a snapshot prop (it's an async IPC list, not a store; refresh on
`schedule:snapshot-changed` via `useScheduleState`'s existing subscription if trivially
available). No new IPC. Almanac Tailwind tokens throughout.

# Out of scope

- PRD content editing/preview (Scheduler tab owns that — navigation only).
- PRD accepted/draft authoring workflow changes; note/lines metadata from the mock (no data
  source — slug/title/status only).
- Mounting/navigation (PRD 829).

## Engineering standards

Before writing any code, read
`/home/bilko/Projects/session-manager/plugins/session-manager-dev/skills/develop/standards.md`
— it has the Performance, Debugging, API-reuse, TDD, and Execution-discipline rules that apply
to this PRD. Every rule in it is mandatory, especially Execution discipline (bounded commands,
verify before done, the finish-protocol sentinel).

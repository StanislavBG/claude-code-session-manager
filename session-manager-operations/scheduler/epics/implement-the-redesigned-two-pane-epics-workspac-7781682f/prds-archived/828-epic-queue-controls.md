---
title: Epics redesign 6/8 — queue controls (search, filters, sort, paging, pinning, keyboard)
cwd: ~/Projects/session-manager
estimateMinutes: 18
sourcePromptId: implement-the-redesigned-two-pane-epics-workspac-7781682f
---

# Goal

Add the control layer on top of PRD 827's `EpicQueue` component (read
`src/renderer/components/epics/EpicQueue.tsx` as actually landed first — it accepts an
already-filtered/sorted list): search, counted filter chips, group/sort selects, per-section
paging, pin-to-top with persistence, compact toggle, and j/k keyboard navigation. Spec:
`session-manager-operations/design-mocks/epics/DESIGN_SPEC.md` (§"Left pane"); mock:
`epics-mock.jsx` (EpicQueue's filter/group/sort/pins logic, MiniSelect, PAGE=18).

# Acceptance criteria

## Core functionality

- [ ] Search input (icon + clear button) filtering title+goal+kind, with a "No Epics match"
  empty state offering Clear filters.
- [ ] Filter chips with live counts: `Open N` (default; = not completed), `Needs you N`,
  `Running N`, `Pinned N`, `All N`. Extend `ui/FilterPills.tsx` with an optional count slot
  rather than writing a parallel pill group (API-reuse).
- [ ] Group select (status | tag | recency buckets Today/This week/This month/Older) and sort
  select (last activity | title | PRD count) as compact labeled selects per the mock's
  MiniSelect; compact-rows toggle button.
- [ ] Per-section paging: first 18 rows, then a dashed "Show 40 more · N hidden" button per
  section; counts must be accurate.
- [ ] Pinning: per-row pin toggle; pinned rows float in a sticky "pinned" section above the
  groups; pinned state + sort + group + compact persist via the `projectsPrefs` pattern
  (`src/renderer/lib/projectsPrefs.ts` — extend it or add `epicsPrefs.ts` beside it following
  the same shape).
- [ ] Keyboard: j/k and Arrow Down/Up move selection through the visible (filtered, paged,
  pinned-first) row order; suppressed when focus is in an input/textarea/select or when the
  CommandPalette is open. Check `src/renderer/lib/keybindings.ts` and CommandPalette for
  conflicts before choosing the listener level. Footer strip: "N shown · M need you" +
  "j / k to move".

## Edge cases

- [ ] Filter+group compose (e.g. Needs-you filter with tag grouping); pinned rows are
  excluded from group sections while pinned; unpinning returns the row to its section.
- [ ] Counts derive from plain functions over snapshots — no fresh-value zustand selectors
  (`npm run lint:selectors` must stay green).

## Tests

- [ ] vitest jsdom tests: chip counts; search no-match + clear; paging reveals correct
  remainder; pin float + persistence round-trip (mock storage); j/k order respects
  pinned-first and skips collapsed sections. `timeout 300 npx vitest run <new files>`
  passes; `timeout 300 npm run typecheck` and `npm run lint:selectors` pass.

# Implementation notes

Serial after PRD 827-epic-queue-pane (same files). State one line of what 827 delivered when
you start (its landed component API) in your commit message. Keep filtering/sorting/paging
pure functions in `src/renderer/lib/epicQueueControls.ts` (unit-testable without DOM), and a
thin `EpicQueueControls`/container component wiring them to `EpicQueue`. Persistence:
localStorage via the projectsPrefs pattern — look at how `ProjectsLanding` consumed it before
copying.

# Out of scope

- Any detail-pane work, composer, New Epic card, mounting (828 sibling + 829).
- Virtualized list rendering (paging is the scale mechanism).

## Engineering standards

Before writing any code, read
`/home/bilko/Projects/session-manager/plugins/session-manager-dev/skills/develop/standards.md`
— it has the Performance, Debugging, API-reuse, TDD, and Execution-discipline rules that apply
to this PRD. Every rule in it is mandatory, especially Execution discipline (bounded commands,
verify before done, the finish-protocol sentinel).

---
title: Epics redesign 2/8 — EpicQueue pane (rows, grouping, sections, selection)
cwd: ~/Projects/session-manager
estimateMinutes: 15
sourcePromptId: implement-the-redesigned-two-pane-epics-workspac-7781682f
---

# Goal

Build the left "Epic queue" pane of the redesigned Epics workspace as a new component
`src/renderer/components/epics/EpicQueue.tsx`: grouped, collapsible, selectable Epic rows in
comfortable and compact densities, per the design spec
`session-manager-operations/design-mocks/epics/DESIGN_SPEC.md` (§"Left pane") and the decoded
mock `session-manager-operations/design-mocks/epics/epics-mock.jsx` (QueueRow/EpicQueue —
translate the mock's inline styles to the app's Tailwind Almanac tokens, do not port hex
values).

# Acceptance criteria

## Core functionality

- [ ] `EpicQueue.tsx` renders a fixed-width aside (352px, `border-line`, `bg` panel tone) with
  a header ("EPIC QUEUE" mono micro-label, total count, accent "New Epic" button that calls an
  `onNew` prop) and a scrollable body of grouped sections.
- [ ] Grouping by status (order: running, needs, queued, draft, completed) using
  `epicDisplayStatus` from `src/renderer/lib/epicDerive.ts` (built by PRD 826 — read it
  first). Section headers are sticky, collapsible (chevron rotates), show a colored dot +
  uppercase mono label + count + trailing hairline; the `completed` section starts collapsed.
- [ ] Comfortable row: status chip + kind chip + activity age on the first line; bold title;
  meta line with PRD count (from `epicPrds`), turn count when available (from `epicStats`,
  omit when null). Selected row gets card background, a 3px inset status-colored left bar and
  subtle shadow. Compact row: status dot + single-line title + age. A `compact` prop switches
  densities.
- [ ] Status chips and kind tags are small shared components in
  `src/renderer/components/epics/epic-primitives.tsx` (`EpicStatusChip`, `EpicKindTag`)
  following the sched-primitives pattern (`components/tabs/scheduler/sched-primitives.tsx`) —
  colors from Tailwind tokens: running=accent, needs=delta.bad/red tone, completed=sage,
  queued/draft=muted. Kind tints: Feature=sage, Bug=accent-dark/red, Discussion=fg-faint.
- [ ] Selection is controlled: props `selectedId`, `onSelect(id)`. Rows carry
  `data-testid="epic-queue-row"` and `data-epic-id`.

## Edge cases

- [ ] Empty queue renders a centered empty state (reuse `ui/EmptyState.tsx`) inviting "New
  Epic" — not a blank pane.
- [ ] Renders 200 generated Epics without a hung test (see Tests) — no per-row store
  subscriptions; the component receives the epic list + snapshots via props/one top-level
  subscription.

## Tests

- [ ] vitest jsdom tests (pattern: `src/renderer/components/__tests__/`): grouping order and
  completed-collapsed default; selection callback fires with the row's epic id; compact vs
  comfortable render; empty state; a 200-epic fixture renders under the default test timeout.
- [ ] `timeout 300 npx vitest run <new test files>` passes; `timeout 300 npm run typecheck`
  and `npm run lint:selectors` pass.

# Implementation notes

Depends on PRD 826 (epicDerive.ts, tag on PromptSession, completed hydration) — it landed
before this wave; read its exports rather than re-deriving. Data comes from
`usePromptSessions` (`state/promptSessions.ts`) + `useChat` + `useScheduleState` snapshots
selected ONCE at the workspace level and passed down (CLAUDE.md Avoid: no fresh-value zustand
selectors — `npm run lint:selectors` enforces). Activity age: derive from the last event
timestamp in `usePromptSessions.events[id]` (fallback `createdAt`); render with an
`agoLabel()` helper — check `src/renderer/lib/` for an existing relative-time helper before
writing one. Search/filter/sort/pin/keyboard controls are PRD 828's job — build this
component so 828 can wrap/extend it (accept an already-filtered, already-sorted list prop).
Styling: Tailwind classes with the Almanac tokens from `tailwind.config.js` (bg/bg-elev/
bg-hi, line/rule, fg/fg-dim/fg-faint, accent, sage); fonts font-sans/font-serif/font-mono.

# Out of scope

- Search, filter chips, group/sort selects, paging, pinning, keyboard nav (PRD 828).
- The right detail pane, composer, New Epic card, and any mounting/navigation changes
  (PRDs 827-siblings and 829).
- Tokens display and per-Epic branch (dropped — no data source).

## Engineering standards

Before writing any code, read
`/home/bilko/Projects/session-manager/plugins/session-manager-dev/skills/develop/standards.md`
— it has the Performance, Debugging, API-reuse, TDD, and Execution-discipline rules that apply
to this PRD. Every rule in it is mandatory, especially Execution discipline (bounded commands,
verify before done, the finish-protocol sentinel).

---
title: Perf P7: memo the mapped list-row components (Turn, JobRow) and stop the 1s tick re-rendering every job row
cwd: /home/bilko/Projects/session-manager
estimateMinutes: 40
sourcePromptId: performance-identiy-why-session-manager-is-feeli-24e0a0ae
sourceTabId: performance-identiy-why-session-manager-is-feeli-24e0a0ae
---
# Goal

Round 1 memoized the 17 screen components, but the components rendered INSIDE those screens' mapped lists are still unmemoized, and they are the ones rendered N times. Two concrete cases. (1) SchedulePanel.tsx:879 exports JobRow, rendered in a map at :468 with a `now` prop that the 1s ticker at :134 updates every second while the panel is focused — so every queued job row re-renders once per second, and `eta={etaForJob(...)}` is recomputed inline per row per render at :471. (2) ChatTranscriptTurn.tsx:968 exports Turn (a ~430-line component), rendered per timeline item from EpicDetail.tsx:899 and :976 with no memo and no virtualization, over a feed capped at 1000 turns. Memoize both and stop the per-second tick from invalidating rows whose displayed value did not change.

# Acceptance criteria

- [ ] JobRow (SchedulePanel.tsx:879) is wrapped in React.memo.
- [ ] The per-second `now` tick no longer re-renders a job row whose rendered output is unchanged. Either quantize `now` to the granularity the row actually displays (e.g. whole seconds of remaining ETA) before passing it down, or move the ticking value behind a custom memo comparator, or have the row subscribe to the tick itself. State the approach chosen in the result.
- [ ] etaForJob is no longer recomputed inline inside the map for every row on every render (SchedulePanel.tsx:471) — memoize per job or compute the whole eta map once per tick.
- [ ] Turn (ChatTranscriptTurn.tsx:968) is wrapped in React.memo.
- [ ] TurnFrame (ChatTranscriptTurn.tsx:536) and TurnRawFooter (:442) are each either memoized or verified cheap and listed with a reason in the result.
- [ ] A render-count test asserts that with 20 job rows mounted and only the 1s tick advancing (no queue-snapshot change), the number of JobRow re-renders per tick is 0 for rows whose displayed ETA text is unchanged.
- [ ] A render-count test asserts that appending one new turn to a 50-turn Epic timeline re-renders only the new turn, not all 51.
- [ ] No behaviour regression: a running job's ETA still counts down on screen, and an in-flight assistant turn still updates live. Add a test for each.
- [ ] timeout 300 npm run typecheck passes.
- [ ] timeout 600 npm run test:unit passes.
- [ ] timeout 120 npm run lint passes.
- [ ] The result reports measured render counts before and after for both cases, from the new tests' spies.

# Implementation notes

Target project: /home/bilko/Projects/session-manager

Key files: src/renderer/components/SchedulePanel.tsx (JobRow at 879, map at 468-476, 1s ticker at 134-138, 5s ticker at 1136), src/renderer/components/ChatTranscriptTurn.tsx (Turn at 968, TurnFrame at 536, TurnRawFooter at 442), src/renderer/components/epics/EpicDetail.tsx (timeline map at 873, Turn call sites 899 and 976).

Follow the pattern already established by perf-screen-memo (c8896be): `export const X = memo(XComponent)` with the inner function renamed `XComponent`. Keep the exported name identical so no call site changes.

TWO INVARIANTS FROM CLAUDE.md THAT OUTRANK THIS OPTIMIZATION — do not let a memo bailout break either:
1. A turn asking the human something (role 'question'/'notice') is never hidden or clamped at any verbosity level. If a memo comparator ever stops such a turn from updating, a run sits waiting on an answer nobody can see.
2. The in-flight bubble keeps its tool strip at every level — mid-run it is the only progress signal there is. A memoized Turn MUST still re-render while streaming.

Beware the two documented crash classes: never return a freshly-built value from a zustand selector (React #185, blank app), and never declare a hook below a top-level early return (React #300/#310). SchedulePanel has already been bitten by the second one. npm run lint runs both checkers.

Prefer quantizing the ticking value over writing a custom `areEqual` comparator — a hand-written comparator that forgets a prop is a silent staleness bug, whereas quantizing is provably correct because the row cannot display more precision than it receives.

Renderer tests use vitest (npm run test:unit).

# Out of scope

- Virtualizing either list (bigger change, scroll-restoration risk)
- Changing chatVerbosity filtering rules or turnMinVerbosity behaviour
- Lowering FEED_TURNS_CAP
- Changing the scheduler queue data model or ETA maths itself

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).

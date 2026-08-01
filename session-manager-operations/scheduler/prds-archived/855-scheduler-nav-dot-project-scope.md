---
title: Scope Scheduler left-nav dot and WindowStrip stats to the active tab's project
cwd: /home/bilko/Projects/session-manager
estimateMinutes: 12
---
# Goal

The Scheduler surfaces leak other projects' jobs into project-scoped UI. useLiveIndicators() in src/renderer/components/layout/AlmanacSidebar.tsx:95-102 lights the left-nav Scheduler activity dot when ANY job on the machine is running, ignoring which project it belongs to. Separately, WindowStrip in src/renderer/components/tabs/Scheduler.tsx:74-168 computes its pending/running/completed-today counts from snapshot.jobs raw, ignoring the "This project / All projects" scope toggle defined further down the same file — so the header stats contradict the scoped job list rendered directly beneath them. Filter both by the active tab's cwd, matching the pattern the three content panes already use.

# Acceptance criteria

- [ ] ## Core functionality
- [ ] useLiveIndicators() in src/renderer/components/layout/AlmanacSidebar.tsx returns scheduler: true only when a running job's cwd matches the active tab's cwd (read from useSessions the same way Scheduler.tsx:185-187 does: tabs.find(t => t.id === activeTabId)?.cwd ?? null).
- [ ] WindowStrip in src/renderer/components/tabs/Scheduler.tsx accepts a scopeCwd: string | null prop and filters snapshot.jobs by j.cwd === scopeCwd before computing the pending / running / completed-today counts.
- [ ] Scheduler() passes its already-computed scopeCwd (line 188) down to <WindowStrip /> at line 219, so toggling This project / All projects updates the header stats and the job list below them together.
- [ ] ## Edge cases
- [ ] When there is no active tab (activeCwd === null), both surfaces fall back to unfiltered machine-wide behavior — this matches the toggle's own existing documented behavior (its title attribute at Scheduler.tsx:234 reads 'No active tab — showing all projects'). Do not render an empty strip or a permanently-dark dot in that state.
- [ ] Jobs whose cwd is undefined/missing in the snapshot must not throw and must not be counted into a scoped project.
- [ ] The reset countdown, utilization percentage, and 'last batch' timestamp in WindowStrip stay machine-wide and are NOT filtered — they describe the 5h billing window and the scheduler tick, not per-project work.
- [ ] ## Interaction / integration
- [ ] AlmanacFooter.tsx:31's scheduler-paused pill is left UNCHANGED and stays global — pause is machine-level state in ~/.claude/session-manager/scheduler-machine.json, not per-project.
- [ ] No new zustand subscription is added to state/scheduleState.ts; both call sites keep consuming the existing singleton via useScheduleState.
- [ ] ## Tests
- [ ] A unit test covers the scoping predicate for both surfaces: a snapshot containing running jobs in two different cwds yields scheduler dot on for the matching cwd, off for a non-matching cwd, and on for activeCwd === null. Extend src/renderer/components/layout/__tests__/AlmanacSidebar.test.ts if the existing shape allows, otherwise add a sibling test file.
- [ ] timeout 300 npm run typecheck passes.
- [ ] timeout 300 npm run lint:selectors passes.
- [ ] timeout 600 npm run test:unit passes.

# Implementation notes

Read first: src/renderer/components/layout/AlmanacSidebar.tsx (useLiveIndicators at :95-102), src/renderer/components/tabs/Scheduler.tsx (WindowStrip at :74-168, Scheduler() scope logic at :174-196), src/renderer/state/scheduleState.ts, src/renderer/state/sessions.ts.

Follow the filter pattern the content panes already use — do not invent a new one:
- src/renderer/components/SchedulePanel.tsx:98-100 — `if (!rawSnap || !scopeCwd) return rawSnap; return { ...rawSnap, jobs: rawSnap.jobs.filter((j) => j.cwd === scopeCwd) }` inside a useMemo.
- src/renderer/components/tabs/plans/SchedulerHistoryView.tsx:58 — `if (scopeCwd && j.cwd !== scopeCwd) return false`.
- src/renderer/components/tabs/plans/SchedulerPrdsView.tsx:107 — `.filter((p) => !scopeCwd || p.cwd === scopeCwd)`.
The `!scopeCwd` short-circuit in each is exactly the null-activeCwd fallback the AC requires.

CRITICAL — zustand unstable-selector rule (project CLAUDE.md "Avoid" section, three prior blank-app incidents): never return a freshly-built array/object from a useScheduleState selector. `(s) => (s.snapshot?.jobs ?? []).filter(...)` inside the selector will infinite-loop and blank the app. The existing useLiveIndicators is already correct because it returns a primitive boolean via .some() — keep that shape. Read activeCwd from useSessions FIRST as a primitive string, then close over it inside the .some() predicate:

  const activeCwd = useSessions((s) => s.tabs.find((t) => t.id === s.activeTabId)?.cwd ?? null)
  const schedulerRunning = useScheduleState((s) =>
    (s.snapshot?.jobs ?? []).some((j) => j.status === 'running' && (!activeCwd || j.cwd === activeCwd)),
  )

Note that useSessions selector also must return a primitive (the cwd string or null) — not the tab object, and not a filtered array. `npm run lint:selectors` (scripts/check-unstable-selectors.cjs) guards this; run it.

For WindowStrip, make scopeCwd a required prop and derive the scoped jobs array in a useMemo inside the component (after the existing `if (!snapshot) return null` guard), then compute pending/running/completed from the scoped array while leaving nextReset / utilization / lastRunAt reading from the unscoped snapshot.

Job cwd type: check ScheduleStateSnapshot in src/preload/api.ts for whether job.cwd is optional; if it is, the `j.cwd === scopeCwd` comparison already handles undefined safely (never equal to a non-null scopeCwd).

# Out of scope

- Changing AlmanacFooter.tsx's paused pill or any other footer chip
- Adding per-project pause/resume to scheduler.cjs or scheduler-machine.json
- Any main-process change — this is renderer-only filtering over the existing snapshot
- Changing the scope toggle's UI, its localStorage key, or its default
- Reworking Home.tsx / ProjectHome.tsx scheduler widgets

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).

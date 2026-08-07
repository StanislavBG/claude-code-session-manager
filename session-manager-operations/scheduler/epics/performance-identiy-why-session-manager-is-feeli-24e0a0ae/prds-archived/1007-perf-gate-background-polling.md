---
title: Perf P4: gate background-panel timers on panel focus and dedupe the three sessionSlots pollers
cwd: /home/bilko/Projects/session-manager
estimateMinutes: 40
sourcePromptId: performance-identiy-why-session-manager-is-feeli-24e0a0ae
sourceTabId: performance-identiy-why-session-manager-is-feeli-24e0a0ae
---
# Goal

Dockview mounts panels with renderer:'always' and never unmounts them (Workbench.tsx:78), and the layout is persisted and restored via fromJSON on boot — so every screen the user has ever left open is mounted at startup and keeps its timers running forever. Today that means three independent 5s pollers all calling the same window.api.schedule.sessionSlots() IPC (Home.tsx:255, Home.tsx:873, SessionManagerConfig.tsx:62), two 1-second setNow tickers that re-render large trees (TabBar.tsx:39, SchedulePanel.tsx:128), a 5s ticker at SchedulePanel.tsx:1128, and a 5s git-status child-process spawn at FileTree.tsx:294. The gating mechanism already exists and is unused by these screens: usePanelFocus / usePanelFocusRef in src/renderer/lib/panelFocus.tsx (currently wired only into EditorView, FileTree and FileTabBar). Gate the timers on focus and collapse the duplicate pollers into one shared subscription.

# Acceptance criteria

- [ ] A single shared session-slots source exists (a small zustand store or a module-level cached-singleton-with-subscribers, mirroring the shape already used by src/renderer/lib/useKnownProjects.ts) that performs at most ONE sessionSlots() IPC call per poll interval regardless of how many components consume it.
- [ ] Home.tsx:255, Home.tsx:873 and SessionManagerConfig.tsx:62 all consume that shared source; no component calls window.api.schedule.sessionSlots() on its own interval any more.
- [ ] The shared poller stops polling entirely when no consumer is mounted in a focused panel, and resumes on focus.
- [ ] The 1s tickers at TabBar.tsx:39 and SchedulePanel.tsx:128, and the 5s ticker at SchedulePanel.tsx:1128, are gated so they do not fire while their panel is unfocused. Note TabBar is not inside a PanelFocusProvider — gate it on document visibility or on the layout store instead, and say which in the result.
- [ ] FileTree.tsx:294's 5s git-status interval is gated on usePanelFocusRef so a backgrounded file tree stops spawning git child processes.
- [ ] On regaining focus, each gated surface refreshes immediately rather than waiting a full interval, so no screen shows stale data on return.
- [ ] New unit tests assert: the shared poller issues one IPC call per interval with two consumers mounted; and a gated interval does not fire while unfocused.
- [ ] timeout 300 npm run typecheck passes.
- [ ] timeout 600 npm run test:unit passes.
- [ ] timeout 120 npm run lint passes.
- [ ] The result lists every interval site changed and every one deliberately left ungated, with a one-line reason each.

# Implementation notes

Target project: /home/bilko/Projects/session-manager

Existing mechanism to REUSE, do not reinvent: src/renderer/lib/panelFocus.tsx exports usePanelFocus(panelId?) and usePanelFocusRef(panelId?). Workbench.tsx:57 wraps every screen in <PanelFocusProvider panelId={id}>, so any component inside a screen can call these with no argument. Outside a provider they default to true, which keeps unit tests and non-workbench call sites unaffected.

Full interval inventory found during investigation (gate the ones in the AC; judge the rest and report): useEffectiveSettings.ts:44, whisperWorker.ts:64, TabBar.tsx:39, MicLevelMeter.tsx:110, EpicQueueControls.tsx:147, EpicsWorkspace.tsx:198, MicWizard.tsx:351, SessionManagerConfig.tsx:62, Scheduler.tsx:95, Home.tsx:255, Home.tsx:873, FileTree.tsx:294, SchedulePanel.tsx:128, SchedulePanel.tsx:1128, AlmanacFooter.tsx:37.

Do NOT gate voice/recording timers (MicLevelMeter, MicWizard, whisperWorker) — the privacy invariant in CLAUDE.md requires recording surfaces stay live, and AlmanacFooter is a global chip strip that is never inside a panel.

Beware the two documented crash classes in CLAUDE.md: never return a freshly-built value from a zustand selector (React #185, blank app), and never declare a hook below a top-level early return (React #300/#310, dead pane). SchedulePanel has already been bitten by the second one. npm run lint runs both checkers.

Renderer tests use vitest (npm run test:unit).

# Out of scope

- Unmounting background panels or changing dockview's renderer:'always'
- Changing the scheduler's own polling in the main process
- Changing sessionSlots pool semantics or capacity
- Workbench context-identity changes (separate PRD)

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).

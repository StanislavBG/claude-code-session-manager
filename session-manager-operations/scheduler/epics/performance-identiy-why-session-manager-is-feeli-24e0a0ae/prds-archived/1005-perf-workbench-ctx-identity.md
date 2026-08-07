---
title: Perf P1: stabilize WorkbenchCtxContext so a panel switch stops re-rendering every mounted panel
cwd: /home/bilko/Projects/session-manager
estimateMinutes: 35
sourcePromptId: performance-identiy-why-session-manager-is-feeli-24e0a0ae
sourceTabId: performance-identiy-why-session-manager-is-feeli-24e0a0ae
---
# Goal

Panel switching is O(number of panels ever opened) instead of O(1). Workbench.tsx:315 does <WorkbenchCtxContext.Provider value={ctx}> where ctx IS the component's own props object (export function Workbench(ctx: WorkbenchProps) at Workbench.tsx:88). React creates a fresh props object on every App render, and App.tsx:697-698 passes two inline arrows (onOpenVoice, onOpenScheduler). So every App re-render changes the context value, which re-renders EVERY mounted PanelHost (Workbench.tsx:43), each calling renderScreenComponent for its whole screen. Because dockview mounts panels with renderer:'always' and never unmounts them, this fans out across every screen the user has ever opened. App re-renders on focusedPanelId (App.tsx:48 - i.e. on every panel switch), navFace, activeTabId, tabs, isRecording, wizardOpen. Fix the context identity and memoize the panel host so a switch re-renders nothing.

# Acceptance criteria

- [ ] In src/renderer/App.tsx, the inline arrow props passed to <Workbench> (onOpenVoice, onOpenScheduler, around App.tsx:694-699) are replaced by useCallback-wrapped handlers with stable identity across renders.
- [ ] src/renderer/components/workbench/Workbench.tsx no longer passes the raw props object as the context value: it builds a useMemo'd object from the four callbacks and passes that to WorkbenchCtxContext.Provider, so the value identity changes only when a callback identity actually changes.
- [ ] PanelHost in Workbench.tsx is wrapped in React.memo.
- [ ] A new unit test under src/renderer/components/workbench/__tests__/ asserts that re-rendering the Workbench tree with unchanged callback props does NOT change the context value identity (compare the value captured by a consumer across two renders with Object.is).
- [ ] A new unit test asserts that a focusedPanelId change in the layout store does not cause a memoized PanelHost consumer to re-render (use a render-count spy).
- [ ] timeout 300 npm run typecheck passes.
- [ ] timeout 600 npm run test:unit passes.
- [ ] timeout 120 npm run lint passes (covers lint:selectors and lint:hooks).
- [ ] The result message states the measured render-count before and after for a simulated panel switch with 5 mounted panels, from the new test's spy counts.

# Implementation notes

Target project: /home/bilko/Projects/session-manager

Key files: src/renderer/components/workbench/Workbench.tsx (lines 43-46 PanelHost, 88 signature, 315 Provider), src/renderer/App.tsx (lines 48, 98-99, 165-167 store subscriptions; 694-699 Workbench call site).

DO NOT change dockview's renderer:'always' — keeping panels mounted is a deliberate decision (Workbench.tsx:78 comment) and the human explicitly wants fast switching, which depends on panels staying mounted. This PRD makes the mounted-but-background panels cheap, it does not unmount them.

navigate (App.tsx:59) and handleNewSession (App.tsx:205) are already useCallback'd and stable — only the two inline arrows and the props-object identity are the problem.

Note ScreenRenderCtx is the type in src/renderer/components/screenComponents.tsx. Keep its shape unchanged; only the identity discipline changes.

Renderer tests use vitest (npm run test:unit). This repo does not use node --test.

Beware the documented zustand v5 selector hazard in CLAUDE.md: never return a freshly-built value from a selector. npm run lint:selectors guards it.

# Out of scope

- Changing dockview to renderer:'onlyWhenVisible' or unmounting background panels
- Memoizing the individual screen components (that is a separate PRD, perf-screen-memo)
- Any change to the polling intervals (separate PRD, perf-gate-background-polling)
- Bundle/code-splitting changes

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).

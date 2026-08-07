---
title: Perf P2: memoize the screen components so a background panel reconciles nothing
cwd: /home/bilko/Projects/session-manager
estimateMinutes: 35
sourcePromptId: performance-identiy-why-session-manager-is-feeli-24e0a0ae
sourceTabId: performance-identiy-why-session-manager-is-feeli-24e0a0ae
dependsOn: [perf-workbench-ctx-identity]
---
# Goal

There is exactly ONE React.memo in the whole of src/renderer (verified by grep). Combined with dockview keeping every visited screen mounted forever (renderer:'always'), any render that reaches a panel host reconciles that screen's entire tree. PRD perf-workbench-ctx-identity removes the main trigger by stabilizing the context value; this PRD is the defence in depth that keeps the property true as new components subscribe to hot stores. Wrap the screen components in React.memo and memoize renderScreenComponent's per-id output so a re-render that changes nothing for a screen costs nothing.

# Acceptance criteria

- [ ] Every screen component reachable from renderScreenComponent in src/renderer/components/screenComponents.tsx is wrapped in React.memo (or is verified to already be cheap and is listed with a reason in the result if deliberately skipped).
- [ ] renderScreenComponent memoizes its returned element per NavKey so that calling it twice with the same id and the same ctx identity returns the identical element reference (Object.is true).
- [ ] The memoization is correctly invalidated: a genuine ctx identity change still produces fresh elements. Covered by a test.
- [ ] A render-count test asserts that with 5 panels mounted, a layout-store focus change re-renders zero screen components.
- [ ] No screen loses reactivity: each memoized screen still updates when its OWN store data changes. Add at least one test per store family (config, live, scheduleState, promptSessions) proving a store update still re-renders the relevant screen.
- [ ] timeout 300 npm run typecheck passes.
- [ ] timeout 600 npm run test:unit passes.
- [ ] timeout 120 npm run lint passes.
- [ ] The result lists every component wrapped and every one deliberately skipped, with a one-line reason each.

# Implementation notes

Target project: /home/bilko/Projects/session-manager

Depends on perf-workbench-ctx-identity landing first — that PRD makes the ctx identity stable, which is the precondition that makes memoizing here actually pay off. Do not start until it is complete.

Key file: src/renderer/components/screenComponents.tsx (renderScreenComponent at line 75). It is the documented single source of truth for what a NavKey renders; CLAUDE.md says do not fork this switch, so extend it in place.

Screens: Home, ProjectHome, EditorView, ProjectsWorkspace, Skills, History, Scheduler, Plugins, McpServers, Hooks, Memory, SystemPrompt, Permissions, Settings, AgentLibrary, TagLibrary, HostBilko, VoiceModal(variant=page).

VoiceModal is a special case — the privacy invariant in CLAUDE.md requires recording surfaces stay live. Do not memoize it in a way that can stall a recording-state update. If in doubt, skip it and say so.

Memoizing must not mask a genuine data dependency. If a screen reads a store and that store is the only thing that changes, React.memo on the screen is still correct because the store subscription lives inside it — but verify this per screen rather than assuming, and write the test.

Beware the two documented crash classes in CLAUDE.md: no freshly-built values returned from zustand selectors (React #185), and no hooks below a top-level early return (React #300/#310). npm run lint runs both checkers.

# Out of scope

- Changing dockview's renderer:'always' or unmounting background panels
- Lazy-loading / code-splitting any screen (separate PRD, perf-code-split-heavy-screens)
- Refactoring any screen's internals beyond adding memo boundaries
- Changing the polling intervals

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).

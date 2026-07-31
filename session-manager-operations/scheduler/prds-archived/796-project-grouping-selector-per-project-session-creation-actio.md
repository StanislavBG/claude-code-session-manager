---
title: Project-grouping selector + per-project session creation action
cwd: ~/Projects/session-manager
estimateMinutes: 15
---
# Goal

Add a pure derived grouping layer over the existing flat `tabs` array in `src/renderer/state/sessions.ts` so multiple sessions ("tabs") that share the same `cwd` can be treated as one project group, plus a new store action `addSessionToProject(cwd)` that creates a fresh dormant tab pinned to an explicit cwd (not "the currently active tab's cwd"). This is the foundation link in a 4-PRD chain building multi-session-per-project Terminal support; later PRDs (797/798/799) build the grouped TabBar UI, wire entry points, and add bulk-close/collapse polish on top of what this PRD delivers. No backend/IPC changes are needed — src/main/pty.cjs, chatRunner.cjs, and transcripts.cjs already support N independent sessions per cwd (each keyed by an opaque tabId, not derived from cwd); this PRD is renderer-only.

# Acceptance criteria

- [ ] src/renderer/state/sessions.ts exports a pure function `groupTabsByCwd(tabs: SessionTab[])` (and/or a `useProjectGroups()` selector hook wrapping it) returning an array of `{ cwd: string, tabs: SessionTab[] }`, ordered by first-appearance of each cwd across the input tabs array
- [ ] sessions.ts gains a new store action `addSessionToProject(cwd: string, opts?)` that creates a dormant tab pinned to the given cwd — mirror the existing `new-tab-here` command body in src/renderer/App.tsx (~line 732-737: `addTab({ cwd, startupCommand: null, dormant: true })`) rather than reimplementing tab creation; it must return the new tab's id
- [ ] Do NOT introduce a second/duplicate store holding tab data — this is a derived selector over the existing flat `tabs` array in the current useSessions store (single source of truth; sessions.ts:9-30 SessionTab type and the existing tabs array stay authoritative)
- [ ] Unit tests (new file or extend an existing sessions store test) cover: 0 tabs -> empty groups; 1 project with 1 tab; 2+ tabs sharing one cwd grouped together (mirrors the already-working new-tab-here scenario) in insertion order; 2 distinct projects each producing a separate group; addSessionToProject creates a tab with a fresh id/sessionId (sessionId === id per existing convention at sessions.ts:131) and the passed-in cwd
- [ ] timeout 300 npm run typecheck passes
- [ ] timeout 300 npx vitest run <path to the new/updated test file> passes

# Implementation notes

Read src/renderer/state/sessions.ts in full first — SessionTab type (lines ~9-30), addTab (~line 120-131, note sessionId: id at line 131 and crypto.randomUUID() at line 120). Read src/renderer/App.tsx lines ~726-740 for the existing new-tab-here command and new-tab-pick command — addSessionToProject should be usable as a drop-in replacement building block for a project-scoped variant of new-tab-here (later PRDs wire the UI). Do not touch TabBar.tsx, ProjectsWorkspace.tsx, or App.tsx command wiring in this PRD — those are explicitly PRD 797/798's scope. Follow this repo's zustand store conventions (see CLAUDE.md: state/config.ts, state/live.ts patterns) — keep the new action colocated in sessions.ts next to addTab, not a new file.

# Out of scope

- TabBar.tsx rendering changes (PRD 797)
- Wiring the new action into any button, menu, or command palette entry (PRD 798)
- Renaming any existing UI copy/labels
- Any change to pty.cjs, chatRunner.cjs, or transcripts.cjs (not needed per exploration — they already support N sessions per cwd)

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).

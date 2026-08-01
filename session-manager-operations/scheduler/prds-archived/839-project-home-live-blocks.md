---
title: Project Home live blocks — "What is in flight" + "Waiting on you"
cwd: ~/Projects/session-manager
estimateMinutes: 12
sourcePromptId: home-redesign-global-machine-home-per-project-br-fa12799f
dependsOn: [838-project-home-nav-scaffold]
---

# Goal

Add the two LIVE (never LLM-synthesized) blocks to `src/renderer/components/tabs/projecthome/ProjectHome.tsx` per the "project-home" mock: **NOW · What is in flight** (up to 3 cards for the active project's Epics with status pill + title + one-line note, straight from the Epic queue) and **OPEN · Waiting on you** (tinted cards for pending needs-input questions with an "Answer in Epic →" button that deep-links into the Epics workspace). These render even when no brief.json exists yet. PRD 838 (previous link) landed the `project-home` NavKey, sidebar row, and the `ProjectHome.tsx` scaffold with active-cwd resolution + EmptyState — read its actual landed file first and build on it.

# Acceptance criteria

## Core functionality

- [ ] Shared block chrome extracted once (e.g. `projecthome/ph-primitives.tsx`): mono uppercase accent kicker + serif h2 + `text-fg-faint` note line, matching the mock's `PhBlock` (translate to Tailwind tokens; reuse `components/epics/epic-primitives.tsx` status pills instead of the mock's hex `PH_ST` map).
- [ ] "What is in flight": Epics of the active tab's cwd from `usePromptSessions` (`status === 'active'`, `cwd` match), status via `lib/epicDerive.ts`'s `epicDisplayStatus(epicId, snapshots)` with snapshots assembled exactly like `EpicsWorkspace.tsx` does (sessions + `useChatSignals()` chats + `useScheduleState` jobs + `useScheduledPrds`); ≤3 cards by recency; note line per status: running → the Epic's tag/goal snippet, needs → "waiting on your answer", queued → "ready to run when a slot frees", draft → "not started".
- [ ] "Waiting on you": one tinted card per pending `needs-input` ticket across the cwd's Epics (chats keyed by Epic id; `ticketHistory` entries with `status === 'needs-input'`), showing the question text, "Epic · <goal>" provenance line, and an "Answer in Epic →" button that sets the pending deep-link via `lib/promptSessionDeepLink.ts` and navigates to `terminal`.
- [ ] Both blocks render with brief.json absent; each block shows a quiet `text-fg-faint` empty line ("No Epics in flight." / nothing renders for zero questions — the mock omits the block's cards, keep the section only when there is ≥1 question or show the empty line, pick one and note it in code).

## Edge cases

- [ ] Switching the active tab re-derives both blocks for the new cwd; archived Epics never appear in "What is in flight".

## Tests

- [ ] Pure derive helpers in `src/renderer/lib/projectHomeDerive.ts` (`inFlightCards(cwd, snapshots)`, `openQuestions(cwd, sessions, chats)`) with vitest coverage over plain objects: `timeout 120 npx vitest run src/renderer/lib/__tests__/projectHomeDerive.test.ts` passes.
- [ ] `timeout 120 npm run lint:selectors` passes; `timeout 300 npm run typecheck` passes.

# Implementation notes

Read `/home/bilko/Projects/session-manager/session-manager-operations/design-mocks/home/DESIGN_SPEC.md` ("Surface 2" layout + "Data mapping notes (the Brief)" → Live blocks) and the decoded mock `project-home-mock.jsx` (`PhNow`, the questions block) first. Signal-level chat subscription is mandatory: `lib/useChatSignals.ts`, never a raw `useChat((s) => s.chats)` whole-map subscription (streaming-token re-render trap, PRD 833 I6). Zustand: select raw slices with module-level `EMPTY_*` constants, derive in the component/helper. Deep-link: see how `EpicsWorkspace.tsx` consumes `takePendingPromptSessionId` from `lib/promptSessionDeepLink.ts` — use the matching setter.

# Out of scope

- Synthesized blocks, pins, refresh, sources chips (PRD 840).
- Backend/IPC changes (PRD 837 owns them; this PRD must not touch `src/main/`).

## Engineering standards

Before writing any code, read `/home/bilko/Projects/session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging, API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is mandatory, especially Execution discipline (bounded commands, verify before done, the finish-protocol sentinel).

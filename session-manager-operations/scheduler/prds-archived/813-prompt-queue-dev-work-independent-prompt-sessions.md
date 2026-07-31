---
title: Prompt-Queue dev-work chains mint independent, persisted PromptSessions
cwd: ~/Projects/session-manager
estimateMinutes: 22
---

# Goal

A tab's Prompt Queue (`src/renderer/state/chat.ts`) queues `PromptTicket`s that all share the
owning tab's `sessionId` — including 'develop'-classified tickets that get dispatched to
`dispatchToPrd()` and become a tracked PRD chain. Today `dispatchToPrd()` sends
`sourcePromptId: ticket.chainRootId ?? ticket.id` to `chat:create-prd`, but no real,
independently-sessioned `PromptSession` (`src/renderer/state/promptSessions.ts`, built in PRDs
802-806) is ever minted for that id — it's just an opaque ticket id. Separately,
`usePromptSessions` is pure in-memory except for `markCompleted()`'s archive write, so even
manually-created PromptSessions vanish on reload. This PRD makes every "New item" dev-work chain
(a 'develop'-classified ticket with no `chainRootId`) mint a real, persisted `PromptSession` with
its own `claudeSessionId`, and makes continuation tickets (`chainRootId` set — the composer's
"Continue: <open item>" choice) reuse that same `PromptSession` instead of nothing. This is
prerequisite plumbing: PRD 807 (currently running) wires the scheduler UI to deep-link a PRD row
back to its PromptSession via `sourcePromptId` — today there's nothing real for it to resolve to.

# Acceptance criteria

- [ ] `usePromptSessions` (`src/renderer/state/promptSessions.ts`) persists active sessions +
  their events to disk on create/append, not only on `markCompleted` — add a durable store (e.g.
  one JSON file per session or an index under `session-manager-operations/prompt-sessions/`,
  following the existing `promptSessionArchivePath()` naming convention) written via
  `window.api.config.writeJson` (the existing atomic tmp+rename writer in `config.cjs` — do not
  hand-roll fs writes, per this repo's CLAUDE.md "Avoid" list), and hydrated back into the
  zustand store on app start (or on `ProjectsLanding`'s mount, whichever is less invasive after
  reading both files)
- [ ] In `dispatchToPrd()` (`chat.ts` ~498-528): when `ticket.chainRootId` is unset (a "New item"
  dev-work ticket), call `usePromptSessions.getState().createPromptSession(ticket.cwd,
  ticket.text)` BEFORE calling `window.api.chat.createPrd(...)`, and pass the new PromptSession's
  `id` as `sourcePromptId` (replacing the current `ticket.id`). Add a `promptSessionId` field to
  `PromptTicket` (`chat.ts`'s interface, ~line 48-84) to record this mapping so a later
  continuation ticket sharing this ticket's id as its `chainRootId` can look up and reuse the
  same PromptSession id
- [ ] When `ticket.chainRootId` IS set (a continuation), look up the ROOT ticket's
  `promptSessionId` (from `ticketHistory`) and reuse it as `sourcePromptId` instead of minting a
  new PromptSession
- [ ] On a successful `chat:create-prd` response, call
  `usePromptSessions.getState().appendPromptSessionEvent(sessionId, { kind: 'prd_created',
  prdSlug, causedByEventId: <that session's current tail event id> })` so the PromptSession's own
  event chain records the PRD it spawned — the same chain `PromptSessionArchiveView`/
  `markCompleted` already read
- [ ] A unit test (extend `src/renderer/state/__tests__/promptSessions.test.ts`, and/or add
  coverage near `chat.ts`'s existing tests — read what test files already exist first) asserts: a
  fresh 'develop'-classified ticket with no `chainRootId` creates exactly one new PromptSession; a
  continuation ticket (`chainRootId` set) reuses the existing PromptSession and does NOT call
  `createPromptSession` again; and after a simulated reload/re-hydration, an active PromptSession's
  `id`/`claudeSessionId`/events round-trip correctly through the new persistence
- [ ] `timeout 300 npm run typecheck` passes
- [ ] the relevant `timeout 300 npx vitest run <test files touched above>` passes

# Implementation notes

Read these first, in full: `src/renderer/state/chat.ts` (`dispatchToPrd` ~498-568, `dequeueNext`
~442-472, the `PromptTicket` interface ~48-84, and the composer's chain-picker in
`TerminalChat.tsx` ~340-431/696-716 which sets `chainRootId` via the existing "New item" vs
"Continue: <open item>" dropdown — this is the exact, already-built signal to key off, don't
invent a new classifier); `src/renderer/state/promptSessions.ts` in full (`createPromptSession`,
`appendPromptSessionEvent`'s tail-chain invariant, `markCompleted`'s archive-write pattern,
`promptSessionArchivePath`); `src/main/config.cjs` for the atomic writeJson/readJson IPC pattern
(`window.api.config.writeJson`/`readText`) already used elsewhere in this repo. PRD 807
(`session-manager-operations/scheduler/prds/807-...`) is running concurrently in the scheduler
right now, wiring the scheduler-UI side of this same `sourcePromptId` link — do not duplicate its
work, and do not change the shape of the `sourcePromptId`/`sourceTabId` fields already sent to
`chat:create-prd`, only what value `sourcePromptId` carries.

# Out of scope

- Rendering the scoped `PromptSessionConversation` view inline for a Prompt Queue ticket (next
  PRD in this chain)
- Routing scheduler PRD-finished notifications into the PromptSession's event chain instead of
  the tab's inline transcript (next PRD in this chain)
- Changing non-'develop' (ordinary inline chat) ticket behavior — those keep resuming the tab's
  shared session unchanged
- PRD 807's scheduler-UI-side deep link work

## Engineering standards

Before writing any code, read
`/home/bilko/Projects/session-manager/plugins/session-manager-dev/skills/develop/standards.md` —
it has the Performance, Debugging, API-reuse, TDD, and Execution-discipline rules that apply to
this PRD. Every rule in it is mandatory, especially Execution discipline (bounded commands,
verify before done, the finish-protocol sentinel).

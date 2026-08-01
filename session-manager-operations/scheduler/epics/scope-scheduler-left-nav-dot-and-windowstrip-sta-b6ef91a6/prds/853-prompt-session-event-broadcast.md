---
title: Broadcast promptSession event appends so PRD responses reach an open Epic thread live
cwd: /home/bilko/Projects/session-manager
estimateMinutes: 20
---
# Goal

Scheduler PRD completions never reach an open Epic thread. src/main/scheduler.cjs:1659 calls `appendResponseEvent(job.cwd, prd.sourcePromptId, message)`, which src/main/promptSessionEvents.cjs:56-86 writes into active-index.json on disk with NO IPC broadcast at all. The renderer only learns of events via `usePromptSessions.hydrate(cwd)`, and src/renderer/state/promptSessions.ts:297-298 early-returns whenever there are no NEW session ids — so for an Epic already in memory the response event is discarded forever and only a full app restart surfaces it. Add an IPC broadcast on event append, subscribe to it in the promptSessions store, and fix hydrate to merge events for existing sessions, so the `prompt -> prd_created -> response -> closed` chain renders live.

# Acceptance criteria

- [ ] ## Core functionality
- [ ] - [ ] src/main/promptSessionEvents.cjs gains an `attachWindow(win)` + `broadcast(channel, payload)` pair following the exact pattern already used in src/main/chatRunner.cjs (:356 broadcast, attached from src/main/index.cjs:309 and :1094), and emits an event-appended IPC broadcast whenever an event is appended — including the `response` event written from src/main/scheduler.cjs:1659.
- [ ] - [ ] src/preload/index.cjs exposes a listener for the new channel, following the shape of the existing chat listeners at :388-431 (returns an unsubscribe function).
- [ ] - [ ] src/renderer/state/promptSessions.ts subscribes to the broadcast and merges the appended event into the in-memory session's event list, so an already-loaded Epic updates without a restart.
- [ ] - [ ] src/renderer/components/epics/EpicDetail.tsx's timeline (:256-263) shows the merged `response` event in order, so a PRD completion is visibly reported back in the thread it was dispatched from.
- [ ] ## Edge cases
- [ ] - [ ] `hydrate` at src/renderer/state/promptSessions.ts:297-298 no longer early-returns when `newIds.length === 0` — it merges newly-appended events for sessions ALREADY in memory instead of discarding them, while still not clobbering in-memory state that is newer than disk.
- [ ] - [ ] Events are deduplicated by event id. This matters because src/renderer/state/chat.ts:549-569 (`appendPrdCreatedEvent`) already appends a `prd_created` event optimistically in the renderer while main also writes it to disk — the new broadcast must not produce a duplicate chip in the thread.
- [ ] - [ ] A broadcast for a cwd/session the renderer has never hydrated is ignored without error.
- [ ] - [ ] Broadcasts fired before any window is attached, or after the window is destroyed, do not throw.
- [ ] ## Interaction / integration
- [ ] - [ ] The store-island rule holds: promptSessions.ts must not cross-subscribe to chat.ts or vice versa (see the CLAUDE.md 'Avoid' section). Merge logic lives inside promptSessions.ts.
- [ ] - [ ] No zustand selector returns a freshly-built value; `timeout 300 npm run lint:selectors` passes.
- [ ] - [ ] Atomic-write behavior of appendResponseEvent is unchanged — reuse config.cjs's writeJson, do not reimplement tmp+rename.
- [ ] ## Tests
- [ ] - [ ] Vitest coverage for: the broadcast firing on append, the store merging an event for an existing in-memory session, hydrate merging instead of early-returning when newIds is empty, and event-id dedupe against an optimistically-appended prd_created event.
- [ ] - [ ] `timeout 300 npm run typecheck` passes.
- [ ] - [ ] `timeout 300 npm run test:unit` passes.

# Implementation notes

Read in this order: src/main/promptSessionEvents.cjs (append path at :56-86), src/main/chatRunner.cjs :356 + `attachWindow` (the pattern to copy), src/main/index.cjs :309 and :1094 (where chatRunner.attachWindow is wired — wire the new one alongside), src/main/scheduler.cjs :1659 (the response-event call site) and :1666-1680 (its fallback tab lookup), src/renderer/state/promptSessions.ts (mint at :167-176, hydrate at ~:290-310), src/renderer/components/epics/EpicDetail.tsx :256-263 and :486-535, src/renderer/components/epics/EpicsWorkspace.tsx :64-69 (re-hydrates on knownCwdsKey change only — insufficient today).

The domain model this restores is documented in CLAUDE.md:12 — the Epic's event chain `prompt -> prd_created -> response -> closed`, FK-linked via `causedByEventId`, is meant to be the auditable trace of everything the Epic spawned.

Use the existing zod IPC schema convention in src/main/ipcSchemas.cjs for any new payload validated at the main-process boundary.

Do not write interactive/GUI acceptance criteria — a headless claude -p run cannot drive the Electron GUI. Prove behavior with vitest, not by launching the app. Do NOT launch a second Electron instance to verify: it SIGTERMs live scheduler jobs and clobbers admin-api.json.

# Out of scope

- Changing how the scheduler decides WHAT message to write as the response event
- The chat:external-send Epic target resolution (sibling PRD)
- Live chat streaming/tool chips (sibling PRD)
- Archiving/closing semantics for completed Epics

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).

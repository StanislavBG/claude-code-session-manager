---
title: Session-per-prompt data model + referential chain (Prompt→PRD→Response→Closed)
cwd: ~/Projects/session-manager
estimateMinutes: 25
---

# Goal

Foundation link (1/5) of a redesign that promotes a top-level "starting prompt" / goal-oriented
prompt to its own independent Claude session, instead of today's model where every PromptTicket
in a tab's queue shares one continuous session (`src/renderer/state/chat.ts:48-84,265-276` —
`PromptTicket.sessionId` is always the owning tab's `sessionId`; confirmed strict 1:1
tab=session=queue, no sub-session concept exists anywhere in the code today). Build the new
`PromptSession` data model: one record per top-level goal, owning its own independent
`claudeSessionId`, and a strictly-referenced chain of the PRDs and responses generated while
pursuing that goal — Prompt → PRD → Response → PRD → Response → ... → Closed. This chain must be
strongly referentially linked (each PRD event stores the exact prior response event it was
generated from; each response event stores the exact PRD event, if any, it is a result of) so
the full history can be reconstructed and audited later — this is an explicit user requirement
on referential integrity, not a nice-to-have. This PRD is data-model + store + tests only — no
UI changes.

# Acceptance criteria

- [ ] A new type `PromptSession` is added (e.g. `src/renderer/state/promptSessions.ts`, a new
  store alongside the existing `sessions.ts`/`chat.ts` stores) with fields: `id`, `cwd`,
  `goalText` (the original top-level prompt text), `claudeSessionId` (own, independent — NOT
  shared with any `SessionTab.sessionId`), `status` (`'active' | 'completed'`), `createdAt`,
  `completedAt: string | null`
- [ ] A `PromptSessionEvent` type models the Prompt→PRD→Response→...→Closed sequence: `id`,
  `promptSessionId` (FK), `kind: 'prompt' | 'prd_created' | 'response' | 'closed'`,
  `causedByEventId: string | null` (FK to the exact prior event it followed from — null only
  for the first `'prompt'` event in a session). A `'prd_created'` event must record the PRD's
  actual filename/slug (not just a title); a `'response'` event must record which
  `'prd_created'` event (if any) it is a response to
- [ ] Store action `createPromptSession(cwd: string, goalText: string): PromptSession` mints a
  fresh independent `claudeSessionId` via `crypto.randomUUID()` (matching the existing pattern
  at `src/renderer/state/sessions.ts:120`) and appends the first `'prompt'` event; it must NOT
  reuse or mutate any existing `SessionTab`
- [ ] Store action `appendPromptSessionEvent(promptSessionId: string, event): PromptSessionEvent`
  enforces the FK chain — it must reject an event whose `causedByEventId` does not reference an
  existing prior event within the same `promptSessionId` (except the session's first event)
- [ ] Unit tests cover: `createPromptSession` mints a session id distinct from every open
  `SessionTab.id`/`sessionId`; appending a valid chain
  `prompt → prd_created → response → prd_created → response → closed` succeeds and every
  event's `causedByEventId` correctly resolves to its actual predecessor; appending an event
  with a `causedByEventId` pointing at a non-existent event is rejected
- [ ] `timeout 300 npm run typecheck` passes
- [ ] `timeout 300 npx vitest run <path to the new test file>` passes

# Implementation notes

Read `src/renderer/state/sessions.ts` (`SessionTab` type ~lines 9-30, `addTab` ~120-131) and
`src/renderer/state/chat.ts` (`PromptTicket` type ~48-84, `send()` ~265-276) in full before
starting. This PRD deliberately does NOT reuse `PromptTicket`'s sessionId-sharing behavior — a
`PromptSession.claudeSessionId` must be independently minted, never derived from an existing tab.

Do not touch `pty.cjs`, `chatRunner.cjs`, or `transcripts.cjs`. Prior architecture review
confirmed they are already keyed by an opaque `tabId`/`sessionId` with no uniqueness constraint
tying it to `cwd` — they already accept N independent session ids per cwd unchanged (the
existing `new-tab-here` command proves this end-to-end). No backend change is needed here.

This is link 1 of a 5-PRD chain (802-806): PRD 803 builds the "Projects" nav list UI reading
this store; PRD 804 builds the scoped conversation view; PRD 805 wires link/file rendering
reuse; PRD 806 builds the completion+archive workflow that persists this exact event chain to
`session-manager-operations/`. Keep this PRD strictly to the data model + store + tests — no
components.

## Engineering standards

Before writing any code, read
`/home/bilko/Projects/session-manager/plugins/session-manager-dev/skills/develop/standards.md`
— it has the Performance, Debugging, API-reuse, TDD, and Execution-discipline rules that apply
to this PRD. Every rule in it is mandatory, especially Execution discipline (bounded commands,
verify before done, the finish-protocol sentinel).

# Out of scope

- Any renderer UI (nav, list, conversation view) — later links in this chain
- Persisting PromptSession data to disk/`session-manager-operations/` (PRD 806 owns persistence)
- Killing/archiving processes (PRD 806)
- Changing `pty.cjs`, `chatRunner.cjs`, or `transcripts.cjs`

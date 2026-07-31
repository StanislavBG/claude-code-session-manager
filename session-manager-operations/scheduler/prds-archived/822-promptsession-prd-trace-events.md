---
title: Wire PRD dispatch + traceability into the Epic (PromptSession) conversation
cwd: ~/Projects/session-manager
estimateMinutes: 25
---

# Goal

`PromptSession` (the "Epic" unit, per `src/renderer/state/promptSessions.ts`) already has a full
audit-chain data model (`PromptSessionEvent`, kinds `'prompt' | 'prd_created' | 'response' |
'closed'`, each linked via `causedByEventId` to its exact predecessor) capable of recording
"one Epic → many PRDs, with discussion in between." Two pieces are still missing to make this
real for the user, both scoped to `src/renderer/components/PromptSessionConversation.tsx` (the
Epic's dedicated, no-right-rail conversation view):

1. **No way to dispatch a prompt as a PRD from inside an Epic's own conversation.** Today
   `dispatchToPrd` (in `src/renderer/state/chat.ts`, ~line 555-620) is only reachable from the
   legacy ticket-queue composer in `TerminalChat.tsx` (Feature/Bug/Discussion tag buttons next to
   Send). `PromptSessionConversation`'s composer only calls the plain `send()` — it can never
   create a `'prd_created'` event because it never calls `dispatchToPrd`.
2. **`'prd_created'` and `'closed'` events are invisible in the transcript.** `dispatchToPrd`
   already appends them to `usePromptSessions`'s per-session `events` array (confirmed at
   `chat.ts:590-604`), but `PromptSessionConversation` only renders `chat.turns` (the raw chat
   messages) — it never reads `usePromptSessions.getState().events[promptSession.id]`, so a PRD
   dispatched from this Epic is invisible in its own conversation.

# Acceptance criteria

## Composer: dispatch as PRD

- [ ] `PromptSessionConversation.tsx`'s composer gains a Feature/Bug/Discussion tag selector
      (reuse `TicketTag` type + `TagChip`/tag-button styling already defined in
      `TerminalChat.tsx` — do not fork a second tag enum or a second set of tag-colored buttons;
      extract the shared bits into a common module if `TerminalChat.tsx` doesn't already export
      them cleanly).
- [ ] Sending a prompt from this composer calls `dispatchToPrd`-equivalent logic (reuse
      `useChat`'s existing `dispatchToPrd` — check its exact exported signature in `chat.ts`
      around line 550-620 before wiring; it takes a ticket-shaped object today, so either adapt
      the call site to construct the minimal shape it needs, or extract dispatchToPrd's core
      into a helper callable with `{ promptSessionId, cwd, text, tag }` directly — prefer the
      extraction if the ticket-shaped parameter has fields not applicable to a bare
      PromptSession send, per the API-reuse standard: one implementation, not a duplicate).
- [ ] The dispatched PRD's resulting `'prd_created'` PromptSessionEvent is appended exactly as
      `dispatchToPrd` already does for the legacy flow (same `causedByEventId` chaining against
      the session's current tail event) — reuse the existing append logic, do not reimplement it.
- [ ] A dispatch failure (PRD authoring error) surfaces via `toast.error(...)` (see
      `src/renderer/state/toast.ts` — this repo's convention per CLAUDE.md: "Toast is the
      user-facing error channel").

## Transcript: render event-chain inline

- [ ] `PromptSessionConversation.tsx` reads `usePromptSessions((s) => s.events[promptSession.id])`
      and interleaves `'prd_created'` and `'closed'` events into the rendered transcript
      alongside `chat.turns`, ordered by each item's timestamp (`PromptSessionEvent.at` vs each
      turn's own timestamp field — check `ChatTranscriptTurn.tsx`'s `Turn` type for what
      timestamp field turns carry; if turns have no reliable per-turn timestamp, order events
      immediately after the assistant turn matching `causedByEventId`'s tail, which is
      deterministic given the chain model).
- [ ] A `'prd_created'` event renders as a small inline chip (reuse the existing
      `openPrdSlug`-triggering button pattern already used for `ticket.prdSlugs` in
      `TerminalChat.tsx`'s `QueueTicketPanel`, ~line 279-291 — same "Open PRD" affordance,
      clicking navigates to Scheduler and opens that PRD) labeled with the PRD slug, e.g.
      `#822-epics-nav-rename`.
- [ ] A `'closed'` event renders as a small muted system-line ("Marked completed" or similar),
      not styled as a chat bubble.
- [ ] `'prompt'` events (the session's own opening goal) are NOT re-rendered separately — the
      transcript still opens with the empty-state / first turn as today; only `'prd_created'`
      and `'closed'` are newly surfaced (`'response'` events are also already implicitly covered
      by the existing turn rendering — do not double-render them).

## Tests

- [ ] Extend or add a test alongside the existing
      `src/renderer/components/__tests__/PromptSessionConversation.test.tsx` covering: sending a
      tagged prompt creates a `'prd_created'` event with correct `causedByEventId` chaining, and
      that event renders as a clickable PRD chip in the transcript.
- [ ] `timeout 300 npm run typecheck` passes.
- [ ] `timeout 120 npx vitest run src/renderer/components/__tests__/PromptSessionConversation.test.tsx src/renderer/state/__tests__/promptSessions.test.ts src/renderer/state/__tests__/chat.test.ts` passes.

# Implementation notes

Read `/home/bilko/.claude/session-manager/scheduled-plans/PRD_AUTHORING.md` and
`/home/bilko/Projects/session-manager/plugins/session-manager-dev/skills/develop/standards.md`
before starting — every rule in `standards.md` is mandatory (TDD, execution discipline, bounded
commands, API-reuse/single-source-of-truth).

Key existing pieces to read first, in full, before writing anything:
- `src/renderer/state/promptSessions.ts` — `PromptSessionEvent`, `appendPromptSessionEvent`
  (throws if `causedByEventId` isn't the current tail — chain, not tree; respect this invariant).
- `src/renderer/state/chat.ts` lines ~550-620 — the existing `dispatchToPrd` flow: it already
  calls `window.api.scheduler.createPrd(...)` then appends the `'prd_created'` event on success.
  This is the ONLY place that currently creates PRDs from a PromptSession-linked conversation —
  reuse its logic rather than writing a second PRD-creation path.
- `src/renderer/components/TerminalChat.tsx` — `TagChip` component (~line 185-194), the
  Feature/Bug/Discussion composer buttons (search for `composerTag`), and `QueueTicketPanel`'s
  PRD-chip rendering (~line 279-291, `openPrdSlug`) — the exact visual/interaction pattern to
  reuse, not reinvent.
- `src/renderer/components/PromptSessionConversation.tsx` — the file being extended. Note its
  existing `respondedTurnIds` module-level dedup pattern (~line 16) for folding assistant turns
  into `'response'` events — follow the same "module-level Map keyed by session id" idiom if a
  similar one-shot-per-render guard is needed for the new interleaving logic, rather than
  inventing a different dedup mechanism.

This PRD's sibling in the same parallel group (822), `822-epics-nav-rename.md`, is a pure
label-rename PRD and does not touch any of the files above — no coordination needed, but don't
assume its renames have landed (they may run in either order).

A follow-on PRD (823, sequenced after this one) will remove the legacy TerminalChat
ticket-queue/ChatSessionRail experience now that the Epic conversation has its own dispatch +
traceability. Do not delete or modify `QueueTicketPanel`/`ChatSessionRail`/`TicketDetailView`
in this PRD — only reuse their patterns/exports.

# Out of scope

- Deleting or disabling the legacy `TerminalChat.tsx` ticket-queue flow — handled in PRD 823.
- Renaming any labels — handled in the sibling PRD `822-epics-nav-rename.md`.
- Changing the `PromptSessionEvent` data model shape (kinds, fields) — it already supports this
  feature; this PRD is UI wiring only.

## Engineering standards

Before writing any code, read
`/home/bilko/Projects/session-manager/plugins/session-manager-dev/skills/develop/standards.md`
— it has the Performance, Debugging, API-reuse, TDD, and Execution-discipline rules that apply
to this PRD. Every rule in it is mandatory, especially Execution discipline (bounded commands,
verify before done, the finish-protocol sentinel).

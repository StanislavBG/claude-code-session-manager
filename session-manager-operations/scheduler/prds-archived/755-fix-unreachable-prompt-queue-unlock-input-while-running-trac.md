---
title: Fix unreachable prompt queue: unlock input while running, track first-send ticket, always-visible queue panel
cwd: ~/Projects/session-manager
estimateMinutes: 20
---
# Goal

The per-tab prompt queue (PRD 748/750) is unreachable in practice: the chat textarea is disabled while a turn is running (TerminalChat.tsx:773, `disabled={running}`), so a user can never type/submit a second prompt to trigger queuing at all. Separately, even if a prompt does queue and later runs, the very first/immediate send in a tab never gets a PromptTicket (dispatchSend() in chat.ts:259-284 sets `running: true` but never sets `activeTicket`, unlike the dequeue path at chat.ts:297+ which does) — so the queue panel has nothing to show for the in-flight turn even when it's the only ticket. Fix both, and always render the queue panel (with a "Queue" header and an empty-state icon/message) instead of returning null when there are zero tickets, so the feature is discoverable even before anything is queued.

# Acceptance criteria

- [ ] Remove `disabled={running}` from the textarea at TerminalChat.tsx:773 (or replace with a narrower disable condition if a real reason exists — e.g. only disable while the very first hydration is in flight, not while `running`). Sending while `running` must go through the existing chat.ts `send()` queuing branch (chat.ts:189-209), not attempt a duplicate concurrent chatRunner.run() call — confirm this is already guaranteed by send()'s existing `if (cur.running)` branch and does not need new guarding.
- [ ] The Send button (TerminalChat.tsx:786-792, currently only rendered in the non-running branch since ~line 778 branches running→Cancel-button / else→Send-button) must also be reachable while running so a typed prompt can actually be submitted and queued — e.g. keep both Cancel and Send available while running (Send enqueues via the same `submit`/`send()` call path used today), or adjust layout so submitting while running doesn't require clicking Cancel first. Preserve existing Cancel behavior unchanged.
- [ ] In dispatchSend() (chat.ts:259-284), construct a PromptTicket (same shape as the one built in send()'s queue branch at chat.ts:193-201, and the one built in dequeueNext() at chat.ts:297+) and set it as `activeTicket` in the same setState call that sets `running: true` (chat.ts:263-268), so the very first send in a tab is represented in `displayTickets` immediately, not only after a second prompt has been queued and dequeued.
- [ ] Verify the existing ticket-finalization logic (chat.ts:234-245, the 'done' transition, and the 'failed' transition around chat.ts:335-339) already correctly folds this newly-set activeTicket into ticketHistory when the turn completes — if any finalization path assumed activeTicket could only exist via dequeueNext(), fix it to handle the dispatchSend()-originated ticket the same way. Add/adjust a test covering this.
- [ ] In TerminalChat.tsx, change QueueTicketPanel (line 339-340) to NOT return null on an empty tickets array. Instead always render the panel shell with a header reading exactly "Prompt queue" (reuse the existing header markup/copy at line 346-348) and, when `tickets.length === 0`, an empty-state block (icon + short message, e.g. 'No prompts queued' — follow this codebase's existing empty-state pattern, see components/ui/EmptyState.tsx per CLAUDE.md's shared primitives list) instead of the ticket `<ul>`.
- [ ] Add/update renderer tests: (a) chat.ts test confirming dispatchSend() sets activeTicket (extend the existing PRD 748 test file covering send()/queue behavior), (b) a TerminalChat.tsx or QueueTicketPanel test confirming the panel renders with header+empty-state when tickets is empty, and with the ticket list when non-empty.
- [ ] Manually reasoned check (not just typecheck): with the textarea unlocked, typing and sending a second prompt while the first is running must still respect the FIFO order and per-tab chatRunner exclusivity already built in PRD 748 — do not weaken or duplicate that serialization.
- [ ] npm run typecheck passes.
- [ ] timeout 120 npx vitest run <path(s) to the updated/added test files> passes.

# Implementation notes

Read first: src/renderer/components/TerminalChat.tsx (QueueTicketPanel at line 339, its render call at line 750, the textarea + Send/Cancel button block at lines 763-794), src/renderer/state/chat.ts (send() at line 185, dispatchSend() at line 259, dequeueNext() at line 297, the 'done'/'failed' finalization blocks around lines 234-245 and 335-339, PromptTicket type at line 47). Also check components/ui/EmptyState.tsx (per this project's CLAUDE.md, listed among shared UI primitives) for the existing empty-state visual pattern to reuse rather than inventing a new one. This PRD is UI + store wiring only — it does not touch chatRunner.cjs's FIFO/concurrency logic (PRD 748 already built and tested that; this PRD's job is making the UI actually expose it and giving the first send a visible ticket, nothing about the underlying serialization changes).

# Out of scope

- Any change to chatRunner.cjs's FIFO/concurrency-cap logic
- The external-prompt-enqueue plumbing (PRD 753) or the scheduler-completion hook (PRD 754) — unrelated, already queued separately
- Redesigning the queue panel's visual style beyond adding a header (reuse existing) and an empty state (reuse EmptyState.tsx pattern)
- Changing PRD dispatch/classification logic (promptClassifier.ts) — untouched by this PRD

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).

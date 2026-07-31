---
title: Chain follow-up prompts onto an open Prompt Queue item's PRD sequence
cwd: ~/Projects/session-manager
estimateMinutes: 25
---
# Goal

Depends on PRD 773 (chat:create-prd IPC wiring) and PRD 774 (Feature/Bug tags), both of which must land first — read their actual landed diffs before starting, not just their plans. Today, every 'develop'-classified ticket gets its own fresh sourcePromptId (its own ticket.id) and its own single-entry prdSlugs array — there is no way to route a follow-up prompt into an existing, still-open Prompt Queue item's PRD chain. This PRD adds that: when the user submits a new prompt while at least one ticket in the tab's ticketHistory is 'dispatched-to-prd' and not yet resolved, they get an explicit choice — \"New item\" or \"Continue: <open item>\" — before the prompt is queued. Choosing continue reuses the ROOT ticket's id as sourcePromptId for the new PRD (instead of minting a new id) and appends the new PRD's filename to the ROOT ticket's prdSlugs array, so the whole chain of PRDs for one initiative displays under a single queue entry. This is a deliberate explicit user choice, not an automatic classifier — auto-detecting "is this a continuation" reliably is out of scope and would risk silently misfiling work.

# Acceptance criteria

- [ ] Define and implement a concrete 'resolved' signal for a dispatched-to-prd ticket's chain: a ticket's chain counts as resolved once every slug in its prdSlugs has scheduler job status 'completed' (or is otherwise terminal-successful) per the existing scheduler job status data already available to the renderer (src/renderer/state/scheduleState.ts) — do not build a second polling mechanism, read the existing store
- [ ] Composer submit flow in TerminalChat.tsx: when the current tab has at least one ticket in ticketHistory that is 'dispatched-to-prd' and NOT resolved (per the above), show an explicit picker before the prompt is queued: 'New item' (default when nothing open) vs 'Continue: <truncated text of the open ticket>' (one entry per open, unresolved chain — if more than one is open, list them all, do not silently pick one)
- [ ] Continuing an existing chain: the new PromptTicket created for the follow-up carries a reference to the ROOT ticket's id (add a field to PromptTicket, e.g. `chainRootId?: string`, distinct from the ticket's own `id`); when this ticket is later classified 'develop' and dispatched (via PRD 773's chat:create-prd wiring), the payload's sourcePromptId is the ROOT ticket's id, not this ticket's own id
- [ ] On successful PRD creation for a continuation ticket, the ROOT ticket's prdSlugs array (not the follow-up ticket's) gets the new filename appended — update appendTicketHistory/patch logic so the history entry actually mutated is the root's, and verify the existing chip rendering at TerminalChat.tsx:412-424 (iterates prdSlugs) picks up multiple chips automatically without new rendering code
- [ ] Choosing 'New item' behaves exactly as today — a fresh ticket id used as its own sourcePromptId, no chainRootId set
- [ ] Unit tests in src/renderer/state/__tests__/chat.test.ts cover: no open chains → no picker shown / defaults to new; one open unresolved chain → continuation appends to the root's prdSlugs; a chain whose every prdSlug is 'completed' is no longer offered as a continuation target; choosing 'New item' explicitly while a chain is open still creates an independent ticket
- [ ] timeout 300 npm run typecheck passes
- [ ] timeout 300 npx vitest run src/renderer/state/__tests__/chat.test.ts passes

# Implementation notes

Read first: PRD 773 and 774's actual landed diffs (git log --oneline for their slugs, then git show, to get the real field names/shapes rather than assuming the plan matched execution exactly), src/renderer/state/chat.ts in full (PromptTicket type, dequeueNext, appendTicketHistory, patch), src/renderer/state/scheduleState.ts (how job status per PRD slug is already exposed — reuse this store's selector, do not add a parallel status fetch), src/renderer/components/TerminalChat.tsx composer submit path.

Keep the picker UI minimal — a small inline choice (radio/select) shown only when there's something to choose between; when there are zero open chains it must not appear at all (no empty picker shown for the common case).

# Out of scope

- Automatic/LLM-based new-vs-continuation classification — explicit user choice only, by design
- Prompt Queue layout/panel promotion (next PRD in this chain)
- Detailed per-item chain view UI (later PRD in this chain) — this PRD only makes the data model support chaining; the multi-PRD-sequence display already partially exists via the prdSlugs chip rendering and is expanded properly in a later PRD

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).

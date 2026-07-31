---
title: Turn-panel prompt-queue side panel with live ticket status + PRD links
cwd: ~/Projects/session-manager
estimateMinutes: 25
---
# Goal

Give the Turn-panel chat UI (`TerminalChat.tsx`) a visible queue: while a prompt is running, show it plus any queued-behind tickets in a side panel so the user can keep typing more without losing track. Each ticket's status stays visible through its full lifecycle (queued → running → dispatched-to-prd → done/failed) rather than disappearing once dispatched, and a `dispatched-to-prd` ticket links out to its `prdSlugs` so the user can trace a prompt to the PRD(s) it became.

# Acceptance criteria

- [ ] `src/renderer/components/TerminalChat.tsx` renders a new side panel (adjacent to the existing `Turn()` list, ~line 265) showing the active tab's `queue: PromptTicket[]` from `chat.ts` (added in PRD 748): the in-flight ticket (status `running`) plus any `queued` tickets behind it, in FIFO order.
- [ ] Each rendered ticket shows its `status` with a distinct visual treatment per state (queued / running / dispatched-to-prd / done / failed) — reuse this repo's existing status-badge pattern (e.g. `SchBadge` from `components/tabs/scheduler/sched-primitives.tsx` or an equivalent existing primitive) rather than inventing a new badge component from scratch, per this repo's 'design primitive extraction' convention.
- [ ] A ticket with status `dispatched-to-prd` and a non-empty `prdSlugs` renders a link/reference for each slug that navigates to (or deep-links into) the existing Scheduler tab's PRD view for that slug — reuse existing navigation plumbing used elsewhere for tab-to-tab links (check `AlmanacFooter.tsx`'s pill-click navigation pattern for precedent), not a new routing mechanism.
- [ ] Tickets remain visible in the panel/history through `done` and `failed` terminal states (do not remove from view immediately on completion) — e.g. keep the last N completed tickets visible, or fold them into the existing turn history list with a status marker, whichever fits `TerminalChat.tsx`'s existing rendering model with the least structural change.
- [ ] The panel updates live as ticket status changes (subscribes to the `chat.ts` store like the rest of `TerminalChat.tsx` already does — no new polling mechanism).
- [ ] The queue panel is scoped per-tab only (no cross-tab/global queue view) — matches the per-tab model from PRD 748.
- [ ] Add/extend a component test (or Playwright e2e per this repo's existing `test:e2e` convention, if `TerminalChat.tsx` already has e2e coverage — check first and follow the established pattern) covering: a queued ticket renders in the side panel while another is running, and a ticket's rendered status updates when its `status` field changes in the store.
- [ ] `npm run typecheck` passes.
- [ ] `npm run test:unit` passes (or the relevant scoped subset).

# Implementation notes

Depends on both prior PRDs in this sequence landing first: 748-prompt-ticket-chat-queue.md (introduces `PromptTicket` type + `TabChat.queue`) and 749-prompt-ticket-persistence-classification.md (introduces `sourcePromptId`/status transition to `dispatched-to-prd`, and populates `prdSlugs`) — read both diffs before starting, this PRD is presentation-only on top of their data model. Key files: `src/renderer/components/TerminalChat.tsx` (`Turn()` component ~line 265, reads `useChat` store), `src/renderer/state/chat.ts` (store shape), `components/tabs/scheduler/sched-primitives.tsx` (`SchBadge` status-color convention — reuse, don't fork per this project's CLAUDE.md 'Avoid: reusing primitives across Almanac and Hive designs without coordination' — SchBadge is the Almanac-design status primitive and is the correct one for scheduler-linked status here), `components/layout/AlmanacFooter.tsx` (existing pill-click-to-navigate pattern to Settings/Usage/Scheduler — follow the same approach to link a `dispatched-to-prd` ticket to its PRD in the Scheduler tab).

# Out of scope

- Any changes to the PromptTicket data model itself (already defined in PRD 748/749)
- Global/cross-tab queue view
- New status-badge component design — must reuse SchBadge or an equivalent existing primitive
- Editing or reordering queued tickets (FIFO only, no drag-to-reorder)

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).

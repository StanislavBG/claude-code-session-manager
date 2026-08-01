---
title: Visible Prompt Queue panel for Epic chat
cwd: /home/bilko/Projects/session-manager
estimateMinutes: 20
sourcePromptId: psess-msaj29wk-6
---
# Goal

EpicDetail.tsx currently has no visible list of pending chat prompts for an Epic — chat.ts (src/renderer/state/chat.ts) already models the full queue (TabChat.queue: PromptTicket[] waiting, activeTicket in flight, ticketHistory: PromptTicket[] terminal results capped at TICKET_HISTORY_CAP=20), and useChat.send()/dequeueNext() already enforce "don't insert the next queued prompt into the resumed session until the previous one finishes" (chat.ts:281-323, :466-507) — none of that scheduling logic needs to change. The only gap is UI: EpicDetail.tsx (~line 661-669) renders just a single inline string "queued · position N" with no list of what's actually queued, so a user who sends a follow-up while a turn is running gets no confirmation of what got queued or its position/status. Build a small "Prompt Queue" panel component that makes this existing state visible: the active ticket (if any, with its live status), each queued ticket (FIFO order, position, truncated prompt text), and a short tail of the most recent terminal tickets from ticketHistory (done/failed/dispatched-to-prd/needs-input) so a user can see recent history without hunting through the turn feed.

# Acceptance criteria

- [ ] Add a new component, e.g. src/renderer/components/epics/EpicQueuePanel.tsx, that takes this Epic's TabChat slice (activeTicket, queue, ticketHistory) as props and renders: (1) the active ticket if present, with a status label ('classifying' while ticket.status is 'queued' during the classification round-trip per chat.ts:476, 'running' once dispatched), (2) each item in `queue` in FIFO order with a 1-based position number and a truncated (~80 char) preview of ticket.text, (3) the last 3-5 entries from `ticketHistory` (most recent first) each showing its terminal status (done/failed/dispatched-to-prd/needs-input) with a distinct color/badge per status — reuse an existing status-badge pattern already in the codebase (e.g. SchBadge in src/renderer/components/tabs/scheduler/sched-primitives.tsx, or EpicStatusChip) rather than inventing a new one.
- [ ] Panel is compact and collapsed/hidden by default when there is nothing to show (no activeTicket, empty queue, empty ticketHistory) — render nothing rather than an empty box.
- [ ] Mount the panel in src/renderer/components/epics/EpicDetail.tsx near the existing composer/queued-position UI (~line 651-693), reading `chat` (already selected via useChat in EpicDetail.tsx around line 345-346) so it re-renders live as tickets move from queue -> activeTicket -> ticketHistory. Do not introduce a new zustand selector that returns a freshly-constructed array/object each call (see project CLAUDE.md 'Avoid' section on unstable selectors) — read the raw `chat` slice for this epicId (already done at line 346) and derive the panel's lists inline in the component render, not inside a store selector.
- [ ] The existing single-line 'queued · position N' indicator at EpicDetail.tsx ~line 661-669 is superseded by the new panel's queue list and should be removed (not left duplicated).
- [ ] Add a unit test (e.g. src/renderer/components/epics/__tests__/EpicQueuePanel.spec.tsx or colocated with existing epic component tests) covering: renders nothing when chat state is empty; renders the active ticket; renders queued tickets in FIFO order with correct position numbers; renders recent ticketHistory entries with correct status labels.
- [ ] timeout 120 npx vitest run <path-to-new-test-file> passes
- [ ] timeout 300 npm run typecheck passes
- [ ] npm run lint:selectors passes (scripts/check-unstable-selectors.cjs) confirming no new unstable-selector pattern was introduced

# Implementation notes

Read src/renderer/state/chat.ts in full first — it's the single source of truth for this feature's data: TabChat interface (~line 123-162: turns, running, queuedPosition, queue: PromptTicket[], activeTicket?, ticketHistory?), and PromptTicket interface (~line 55-100: id, text, status: 'queued'|'running'|'dispatched-to-prd'|'done'|'failed'|'needs-input', createdAt, tag, prdSlugs, questionTurnId). dequeueNext() (~line 466-507) is what drains `queue` FIFO one at a time, only after the prior turn's pushTurn()/dispatchToPrd() finalizes it into ticketHistory — this sequencing already exists, do not touch it.

In src/renderer/components/epics/EpicDetail.tsx: `chat` is already read via a hook around line 320-346 (search for `chat?.turns`), and `running`/`chat.queuedPosition` are already destructured at line 346 and used at line 404 and 661-669. The new panel replaces the block at lines 661-669 (the `chat.queuedPosition > 0` ternary branch that renders "queued · position {chat.queuedPosition}") — keep the sibling `epic-live-turn` branch (line 670-691) which renders the in-flight streaming turn; only the queued-position indicator is being replaced/absorbed into the new panel.

For status badge styling, check src/renderer/components/tabs/scheduler/sched-primitives.tsx's SchBadge (status color/mark) and src/renderer/components/epics/epic-primitives.tsx's EpicKindTag/epicStatusDotClass for the color-token conventions already used elsewhere in Epics UI (fg-faint, delta-bad, accent, etc. — see EpicComposer.tsx's className strings for examples of the existing color/spacing vocabulary to match visually).

Use data-testid attributes following this file's existing convention (kebab-case, prefixed e.g. `epic-queue-panel`, `epic-queue-panel-active`, `epic-queue-panel-item`, `epic-queue-panel-history-item`) so the new unit test and any future e2e test can target them.

Do NOT add any ability to cancel/remove/reorder a queued ticket in this PRD — read-only visibility only, out of scope below.

# Out of scope

- Cancel/remove/reorder a specific queued ticket (only the existing whole-run Cancel button in EpicComposer.tsx stays)
- Any change to chat.ts's queueing/classification/dispatch logic — it already implements the required 'wait for previous to finish' sequencing correctly
- Any change to the composer's Chat/Dispatch-as-PRD default (EpicComposer.tsx's defaultAction() is already hard-pinned to 'chat' and must stay that way)
- A cross-Epic or global queue view — this panel is scoped to the single open Epic's own chat.ts TabChat slice

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).

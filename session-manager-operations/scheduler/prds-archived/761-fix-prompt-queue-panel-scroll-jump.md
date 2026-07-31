---
title: Fix Prompt Queue panel visually jumping during an active chat turn
cwd: ~/Projects/session-manager
estimateMinutes: 20
---
# Goal

The user reports the Prompt Queue panel (src/renderer/components/TerminalChat.tsx, `QueueTicketPanel` component, merged into a single right-hand panel by PRD 760 which must land first) visibly "jumps" during an active conversation/turn instead of staying visually stable. `displayTickets` is computed at TerminalChat.tsx:548 via `mergeTicketsForDisplay(ticketHistory, activeTicket, queue)` from src/renderer/lib/ticketDisplay.ts, which already produces a stable FIFO order (ticketHistory oldest-first, then activeTicket, then queue) — so this is very unlikely to be a list-reordering bug. Reproduce the jump live (run the app, send a prompt, queue a follow-up prompt while the first is running, watch the Prompt Queue panel) and find the actual root cause — likely candidates: the panel's `overflow-y-auto` container losing/resetting scroll position on re-render as `displayTickets` array identity changes each tick (chat.ts state updates causing full re-render + implicit scrollTop reset), a ticket's height changing as its status pill/text changes causing layout shift above the scroll viewport, or key instability in the `tickets.map((t) => ...)` list at TerminalChat.tsx:353 causing React to unmount/remount list items. Fix whichever is confirmed as the actual cause; do not guess-fix without reproducing first.

# Acceptance criteria

- [ ] Reproduce the jump: start the app (`npm run dev` or equivalent headless run), open a Chat tab, send a prompt, then send a second prompt while the first is still running so a ticket enters the queue and transitions queued→running→done/dispatched — observe and document in the PRD's own commit message or a code comment what specifically visually jumps (scroll position resets to top? list items shift height? panel re-mounts?).
- [ ] Root cause identified and stated in the commit message with the specific line(s) responsible (e.g. missing scroll-anchor logic, unstable React key, animation/transition class causing reflow) — do not ship a fix without first confirming the mechanism.
- [ ] Fix implemented so the Prompt Queue panel's scroll position is preserved across ticket status transitions during an active turn — e.g. anchor scroll to bottom only when the user was already at the bottom before the update (standard "stick to bottom unless user scrolled up" pattern), or stabilize list item keys/heights so no unintended reflow occurs.
- [ ] A new or updated test in src/renderer/components/__tests__/QueueTicketPanel.test.tsx (or a sibling test file) covers the specific stabilization behavior added (e.g. scroll position unchanged when a ticket transitions status while the container isn't scrolled to bottom).
- [ ] `timeout 120 npx vitest run src/renderer/components/__tests__/QueueTicketPanel.test.tsx` passes.
- [ ] `timeout 300 npm run typecheck` passes.

# Implementation notes

Depends on PRD 760 (760-merge-chat-right-panels-50-50.md) landing first — the merged single-panel structure it produces is what this PRD's scroll-stabilization fix must target; read 760's actual landed diff before starting, don't assume the pre-merge two-panel structure still exists. Key files: src/renderer/components/TerminalChat.tsx (QueueTicketPanel component, ~lines 336-379 pre-merge — confirm actual post-760 location), src/renderer/lib/ticketDisplay.ts (mergeTicketsForDisplay — already stable FIFO, don't relitigate ordering), src/renderer/state/chat.ts (PromptTicket state shape, ticketHistory/activeTicket/queue fields). If the root cause turns out to be React key instability, check what `key={t.id}` resolves to for each ticket type (queued/active/history) to confirm ids are stable and unique across the merged array, not regenerated per render.

# Out of scope

- (none)

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).

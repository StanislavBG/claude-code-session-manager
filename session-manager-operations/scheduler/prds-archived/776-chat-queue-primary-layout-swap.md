---
title: Promote Prompt Queue panel to the primary pane; move chat transcript to the rail
cwd: ~/Projects/session-manager
estimateMinutes: 30
---
# Goal

Depends on PRDs 773-775, which must land first — read their actual landed diffs before starting. Today src/renderer/components/TerminalChat.tsx renders the chat transcript + composer as the main content and QueueTicketPanel as a right-rail widget gated behind showRail (viewport width > RAIL_BREAKPOINT=1180, ~line 597, rendered ~line 839-849). The Prompt Queue is meant to become the primary working surface (users manage follow-up work across different contexts there), with the chat transcript demoted to a secondary rail. This PRD swaps their positions. The composer's text input stays anchored at the bottom of the window regardless of which pane is primary — only the scrollable turn-history area and QueueTicketPanel swap main/rail positions.

# Acceptance criteria

- [ ] ## Layout
- [ ] At viewport width > RAIL_BREAKPOINT (1180px, unchanged constant), QueueTicketPanel renders as the primary/center content area (where the chat transcript scroll area used to be) and the chat transcript scroll area renders in the rail position (where QueueTicketPanel used to be)
- [ ] The composer (textarea + send button + the Feature/Bug tag toggle from PRD 774 + the new/continue picker from PRD 775) remains anchored at the bottom of the window, reachable regardless of which pane is currently primary — it does not move into the rail
- [ ] ## Narrow viewport
- [ ] At viewport width ≤ RAIL_BREAKPOINT, where today only the transcript shows (rail hidden per showRail), the default visible pane becomes the Prompt Queue instead of the transcript, with an explicit toggle/button to switch to the chat transcript view (mirrors the inverted default, not a new interaction pattern)
- [ ] ## Tests
- [ ] Existing component tests referencing the old DOM order (src/renderer/components/__tests__/QueueTicketPanel.test.tsx and any TerminalChat tests asserting pane structure) are updated to match the new positions rather than left broken
- [ ] timeout 300 npm run typecheck passes
- [ ] timeout 300 npx vitest run src/renderer/components/__tests__/QueueTicketPanel.test.tsx passes

# Implementation notes

NOTE: this PRD's implementation already landed via manual recovery after an earlier run stalled
on an interactive screenshot-capture step (since removed from this AC) — commit `aad3399`
("feat(chat): promote Prompt Queue to the primary pane, move transcript to the rail"). If you are
re-running this PRD, first check `git log --oneline -- src/renderer/components/TerminalChat.tsx`
for that commit; if present, the work is done — just re-verify typecheck + the test command below
and report success rather than re-implementing.

Read first: PRDs 773-775's actual landed diffs, src/renderer/components/TerminalChat.tsx in full (the showRail/RAIL_BREAKPOINT logic ~line 207-209 and 597, the JSX layout ~line 830-850), src/renderer/components/__tests__/QueueTicketPanel.test.tsx.

This is a structural JSX/layout change, not a visual redesign of QueueTicketPanel itself (that's the next PRD in this chain) — keep QueueTicketPanel's internal rendering as-is, just change where it mounts. Follow the repo's existing responsive-breakpoint pattern (showRail) rather than inventing a new one.

# Out of scope

- Visual/styling redesign of QueueTicketPanel's internals or the Detailed view (next PRD)
- Mobile web-remote layout — webRemote.cjs does not expose ticket state and this PRD does not add that
- Changing the Scheduler tab's own layout

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).

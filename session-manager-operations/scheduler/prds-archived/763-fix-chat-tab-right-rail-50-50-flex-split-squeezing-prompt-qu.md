---
title: Fix Chat tab right rail 50/50 flex split squeezing Prompt Queue panel
cwd: ~/Projects/session-manager
estimateMinutes: 15
---
# Goal

In src/renderer/components/TerminalChat.tsx, the Chat tab's right-hand rail (the `w-[280px] flex-col` container around line 790) renders ChatSessionRail and QueueTicketPanel as sibling `flex-1` children, so they always split the available height 50/50 regardless of actual content. When ChatSessionRail has little content (idle status, "No tool activity yet"), it still claims half the rail's vertical space, squeezing QueueTicketPanel so its "Prompt Queue" header and ticket list sit cramped near the top border with an unwanted scrollbar even when there's nothing to scroll — reported via a user screenshot of the Chat tab as "the right modules are hidden a bit". Fix the sizing so ChatSessionRail shrinks to fit its content (capped by a max-height with its own overflow-y-auto for the rare long tool-use list) and QueueTicketPanel is the flexible element that absorbs the rail's remaining height.

# Acceptance criteria

- [ ] In src/renderer/components/TerminalChat.tsx, ChatSessionRail's outer wrapper div (currently `min-h-0 flex-1 overflow-y-auto border-b border-rule px-3 py-4` around line 267) no longer uses `flex-1` — it sizes to its content, with a `max-h-[...]` (pick a reasonable cap, e.g. `max-h-[45%]` or a fixed px value that comfortably fits the status box + a handful of tool-use rows) and keeps `overflow-y-auto` so a long 'This turn' tool-use list still scrolls internally instead of pushing QueueTicketPanel off-container.
- [ ] QueueTicketPanel's outer wrapper (line ~373-377, `min-h-0 flex-1 overflow-y-auto px-3 py-4`) keeps `flex-1` so it absorbs whatever vertical space ChatSessionRail doesn't use.
- [ ] The parent flex container at line ~790 (`flex h-full w-[280px] shrink-0 flex-col border-l border-rule`) and the `showRail` conditional gating ChatSessionRail (line ~574, ~791) are unchanged — only the two children's own sizing classes change.
- [ ] No other markup/behavior of ChatSessionRail or QueueTicketPanel changes (their internal JSX/content stays identical) — this is a layout/CSS-only fix.
- [ ] Existing tests referencing these components still pass: run `timeout 300 npx vitest run src/renderer/components/__tests__/QueueTicketPanel.test.tsx` and it's green.
- [ ] `timeout 300 npm run typecheck` passes.
- [ ] Visually verify (via the `run` skill or manual `npm run dev` + Electron window screenshot) the Chat tab's right rail at a viewport wider than 1180px (RAIL_BREAKPOINT) with an idle/near-empty session: ChatSessionRail's box should now take only the vertical space its content needs, and the Prompt Queue panel below it should have its full header visible and get the remaining rail height, not be squeezed to half.

# Implementation notes

Read ~/Projects/session-manager/plugins/session-manager-dev/skills/develop/standards.md before starting — it has the mandatory Performance, Debugging, API-reuse, TDD, and Execution-discipline rules for this PRD.

File: src/renderer/components/TerminalChat.tsx
- ChatSessionRail component definition starts ~line 249; its returned wrapper div is at line 267: `<div className="min-h-0 flex-1 overflow-y-auto border-b border-rule px-3 py-4">`. Change `flex-1` to a shrink-to-content approach with a max-height cap (e.g. `shrink-0 max-h-[45%]` or a fixed cap like `max-h-[260px]` — pick whichever reads better against the existing status-box + This-turn-list content; keep `min-h-0 overflow-y-auto`).
- QueueTicketPanel component definition starts ~line 340; its wrapper div is at line 373-377: `<div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto px-3 py-4" data-testid="chat-queue-panel">`. Leave `flex-1` as-is (it's already correct) — this is the panel that should absorb the freed space.
- Parent container at line 790: `<div className="flex h-full w-[280px] shrink-0 flex-col border-l border-rule">` renders `{showRail && <ChatSessionRail ... />}` (line 791-800) then `<QueueTicketPanel tickets={displayTickets} />` (line 801). Don't touch this container or the showRail gating.
- RAIL_BREAKPOINT = 1180 (line 209) gates whether ChatSessionRail renders at all — only relevant for testing at a wide-enough viewport.
- Test at src/renderer/components/__tests__/QueueTicketPanel.test.tsx already exists for QueueTicketPanel — check it doesn't assert on the exact class list in a way that would need updating, but no new test is required since this is a pure CSS sizing change with no behavioral branch to cover.

# Out of scope

- Redesigning ChatSessionRail's or QueueTicketPanel's internal content/markup
- Changing the RAIL_BREAKPOINT value or responsive behavior below 1180px
- Adding new session-rail fields (branch/model/5h-window/touched-files) — explicitly out of scope per the existing code comment at line 246-248

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).

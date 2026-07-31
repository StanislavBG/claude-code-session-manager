---
title: Merge Chat's two right-hand panels (This Turn + Prompt Queue) into one 50/50 split panel
cwd: ~/Projects/session-manager
estimateMinutes: 15
---
# Goal

TerminalChat.tsx currently renders two separate, independently-widthed right-hand sibling panels inside the chat view: `ChatSessionRail` (src/renderer/components/TerminalChat.tsx:249-323, `w-[280px]`, contains the "This turn" tool-activity list) and `QueueTicketPanel` (same file, lines 336-379, `w-[260px]`, the "Prompt queue" ticket list). Both are rendered as independent `shrink-0` flex children of the `<div className="flex min-h-0 flex-1">` row at line 719 (QueueTicketPanel at 757, ChatSessionRail conditionally at 758-767 behind `showRail`). This is visually too much — two separate columns eating ~540px combined. Consolidate them into ONE right-hand panel container (single border-l, single width) that vertically stacks "This Turn" (top half) and "Prompt Queue" (bottom half), each occupying 50% of the panel's height, each independently scrollable within its own half.

# Acceptance criteria

- [ ] A single wrapping right-hand panel div replaces the two separate ChatSessionRail/QueueTicketPanel top-level containers — one `border-l border-rule` on the outside, not two.
- [ ] Inside that single panel, the existing ChatSessionRail content (session label/cwd/status header + "This turn" tool-activity list, currently lines 267-293 and 295-320) occupies the top 50% height section, and the existing QueueTicketPanel content ("Prompt queue" heading + ticket list/empty-state, lines 341-377) occupies the bottom 50% height section — use a flex-col wrapper with each section as `flex-1` (or `h-1/2`) and `min-h-0 overflow-y-auto` so each half scrolls independently instead of the whole panel scrolling as one unit.
- [ ] The `showRail` viewport-width gate (line 541, `RAIL_BREAKPOINT`) still controls whether the whole merged panel renders at all — preserve existing responsive collapse behavior; don't make the Prompt Queue half unconditionally render when the rail is hidden (check current behavior: QueueTicketPanel today renders unconditionally regardless of showRail — decide and document whether merging changes this, and if it does, keep prompt-queue functionality reachable, e.g. by keeping the queue section rendering unconditionally within the merged panel even when the This-Turn section is hidden below the breakpoint — read the existing showRail usage fully before deciding, and preserve current information availability, don't regress it).
- [ ] Existing data-testid attributes (`chat-queue-panel`, `chat-queue-ticket`) are preserved unchanged so existing tests in src/renderer/components/__tests__/QueueTicketPanel.test.tsx keep passing without modification (run: `timeout 120 npx vitest run src/renderer/components/__tests__/QueueTicketPanel.test.tsx`).
- [ ] `timeout 300 npm run typecheck` passes.
- [ ] `timeout 300 npm run build` succeeds (renderer build).

# Implementation notes

Read src/renderer/components/TerminalChat.tsx in full around lines 240-380 (both panel component definitions) and 719-768 (where they're composed into the row) before editing. `ChatSessionRail` and `QueueTicketPanel` are exported/module-level function components in this same file — keep them as separate functions if useful for readability, but change the JSX composition at ~757-767 to wrap both inside one outer container div (single `border-l border-rule px-3` wrapper, `flex flex-col h-full`), removing the individual `w-[280px]`/`w-[260px]` + `border-l` classes from each inner component (they become plain flex-1 sections instead of independently-widthed top-level panels). Preserve all existing props threading (`tickets`, `cwd`, `label`, `running`, `queuedPosition`, `stream`, `liveToolUses`) unchanged — only the container/layout classes change, not the data flow. Test file to check for coupling to current DOM structure: src/renderer/components/__tests__/QueueTicketPanel.test.tsx.

# Out of scope

- Do not touch the scroll-jump behavior of the Prompt Queue list (tracked separately in PRD 761, which depends on this one landing first) — layout/structure changes only in this PRD.
- Do not change ChatSessionRail's or QueueTicketPanel's internal list-item rendering, ticket status logic, or tool-use trace rendering.
- Do not change the showRail breakpoint threshold itself (RAIL_BREAKPOINT constant).

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).

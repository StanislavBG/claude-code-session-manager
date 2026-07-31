---
title: Feature/Bug tag on Prompt Queue tickets, threaded through to PRD frontmatter
cwd: ~/Projects/session-manager
estimateMinutes: 20
---
# Goal

Depends on PRD 773 (chat-queue-create-prd-wiring), which must land first: it adds the chat:create-prd IPC path and wires a 'develop'-classified PromptTicket to actually create a scheduler PRD. This PRD adds an explicit Feature/Bug tag the user picks when submitting a prompt (not another claude -p classification call — keep it deterministic, cheap, and user-controlled), stores it on the PromptTicket, threads it through to the created PRD's frontmatter, and renders it as a chip in the ticket history / queue panel so queued work is visibly categorized.

# Acceptance criteria

- [ ] PromptTicket (src/renderer/state/chat.ts, ~line 48-61) gains an optional `tag?: 'feature' | 'bug'` field
- [ ] The chat composer in src/renderer/components/TerminalChat.tsx gets a small Feature/Bug toggle next to the send control, defaulting to 'feature'; its selected value is passed into useChat's send() and becomes part of the PromptTicket created for that prompt (both the fresh-send activeTicket path and the queued-ticket path in dispatchSend/dequeueNext must carry it through — read both before changing either)
- [ ] src/renderer/lib/prdFrontmatter.ts's PrdFrontmatter type and RECOGNIZED_KEYS gain an additive `tag?: 'feature' | 'bug'` entry, following the exact same optional/additive pattern already used for sourcePromptId and sourceTabId (~line 24-36 and the RECOGNIZED_KEYS Set) — do not change emit order for existing keys
- [ ] src/main/lib/prdCreate.cjs's buildPrdBody accepts an optional `tag` input and, when present, emits it as a frontmatter line the same way sourcePromptId/sourceTabId are conditionally emitted (~line 58-63)
- [ ] The chat:create-prd IPC handler and schemas.schedulerCreatePrd (src/main/ipcSchemas.cjs) accept an optional tag field ('feature'|'bug') and pass it through to buildPrdBody; chat.ts's dequeueNext 'develop' branch (wired in PRD 773) includes the ticket's tag in the payload it sends
- [ ] Ticket rows in the queue panel (QueueTicketPanel section of TerminalChat.tsx, ~line 340+) render a colored tag chip (Feature vs Bug, visually distinct — reuse the existing status-pill tone pattern in src/renderer/lib/ticketDisplay.ts rather than inventing a new color system) next to each ticket that has a tag set; tickets with no tag (pre-existing history) render with no chip, not an error state
- [ ] Unit test in src/renderer/lib/__tests__/prdFrontmatter.test.ts extended to cover round-tripping the new tag key (parse then re-serialize is byte-identical when untouched, matching the existing sourcePromptId/sourceTabId round-trip tests)
- [ ] Unit tests in src/renderer/state/__tests__/chat.test.ts and src/renderer/components/__tests__/QueueTicketPanel.test.tsx extended to cover: tag flows from composer selection through to the created ticket, and the tag chip renders for a tagged ticket
- [ ] timeout 300 npm run typecheck passes
- [ ] timeout 300 npx vitest run src/renderer/lib/__tests__/prdFrontmatter.test.ts src/renderer/state/__tests__/chat.test.ts src/renderer/components/__tests__/QueueTicketPanel.test.tsx passes

# Implementation notes

Read first (in addition to PRD 773's landed changes — read its actual diff, not just its plan, since scope may have shifted slightly during execution): src/renderer/lib/prdFrontmatter.ts in full (the RECOGNIZED_KEYS Set and PrdFrontmatter type, and how emit order is defined — there's a stable emit-order list this PRD must extend, not reorder), src/renderer/lib/ticketDisplay.ts (ticketDisplayStatus's tone-mapping pattern to mirror for tag colors), src/renderer/components/TerminalChat.tsx (composer JSX near the send button, and the QueueTicketPanel ticket-row rendering), src/renderer/components/__tests__/QueueTicketPanel.test.tsx (existing test shape).

Do not build any automatic feature/bug classification — this is a pure user-selected value, deterministic and free (no additional claude -p call).

# Out of scope

- Auto-classifying feature vs bug via LLM
- Retroactively tagging PRDs/tickets created before this PRD lands
- Any Scheduler-tab (not Chat-tab) UI changes — later PRD in this chain

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).

---
title: Chat: give the needs-input question a real threaded status and reply-in-context affordance
cwd: ~/Projects/session-manager
estimateMinutes: 25
---
# Goal

A headless chat run can stop mid-turn via the `<<<SM_NEEDS_INPUT>>>` sentinel (`src/main/chatRunner.cjs`), broadcast as `chat:run:needs-input` with `{ tabId, sessionId, questions, answerBody, raw }`. Today this renders as a plain amber "❓ Needs your answer" card inline in the transcript (TerminalChat.tsx `Turn` renderer, ~line 459-475) with the static hint "Reply in the composer below to answer." — but nothing in the UI distinguishes a ticket that's actually stalled waiting on the user from one that's merely `done`: `PromptTicket.status` (src/renderer/state/chat.ts:54) is `'queued' | 'running' | 'dispatched-to-prd' | 'done' | 'failed'` with no needs-input/blocked value, so when the sentinel fires the ticket is simply finalized as `'done'` and the Prompt Queue panel (`QueueTicketPanel` in TerminalChat.tsx) shows it as completed. The user reports this as disorienting — they end up typing their answer as what feels like a fresh unrelated prompt instead of a reply that's visibly "in context," because neither the Prompt Queue panel nor the composer reflects that a specific question is still pending. Mechanically the reply already resumes the correct session (composer send always resumes that tab's persistent `sessionId`), so this is a UI/status-clarity gap, not a routing bug: add a real `needs-input` ticket status plus visual treatment in both the Prompt Queue panel and the composer so answering a pending question is unambiguous and requires no context-jumping.

# Acceptance criteria

- [ ] ## Core functionality
- [ ] Add a `'needs-input'` value to the `PromptTicket['status']` union in `src/renderer/state/chat.ts` (currently `'queued' | 'running' | 'dispatched-to-prd' | 'done' | 'failed'`).
- [ ] When `window.api.chat.onNeedsInput(...)` fires (chat.ts ~line 392-421, currently finalizing the ticket as part of the normal completion path), the corresponding ticket for that run is set to `'needs-input'` instead of `'done'`, and only transitions to `'done'`/`'running'` again once the user actually sends a reply on that tab (i.e. the next successful `send()` for that tabId clears the needs-input state back to normal, matching the existing resume behavior).
- [ ] `src/renderer/lib/ticketDisplay.ts`'s status-to-display-tone mapping (`ticketDisplayStatus`) gets a distinct tone/label for `'needs-input'` (e.g. amber, label 'Needs your answer') instead of falling through to whatever the default/closest existing status renders as.
- [ ] `QueueTicketPanel` (TerminalChat.tsx, rendered ~line 790) visually marks a `needs-input` ticket distinctly from `queued`/`running`/`done` (reuse the panel's existing pill/badge styling pattern, amber to match the existing inline question card's color) so a stalled question is scannable at a glance in the queue, not just in the transcript.
- [ ] Clicking a `needs-input` ticket in `QueueTicketPanel` scrolls the transcript to and briefly highlights the corresponding question turn (the amber '❓ Needs your answer' card, TerminalChat.tsx ~line 459-475) and focuses the composer textarea — so from either surface (Prompt Queue panel or the inline question card) the user lands in the same place ready to type, with no tab-switching or hunting.
- [ ] ## Interaction / integration
- [ ] While a tab has an outstanding `needs-input` ticket, the composer's placeholder text changes to make the reply target explicit (e.g. 'Reply to answer the pending question…' instead of the generic 'Type a command…' / 'Running… send to queue a follow-up prompt' placeholders at TerminalChat.tsx ~line 816).
- [ ] This must not change the underlying send/resume mechanics (`send()` in chat.ts already correctly resumes the tab's persistent `sessionId` — do not add a new `respondTo`/answer-specific IPC path; this PRD is status/UI plumbing on top of the existing correct routing, not a new routing mechanism).
- [ ] If a tab has multiple queued tickets AND one of them is `needs-input`, the needs-input one is visually prioritized/pinned near the top of the panel (or otherwise unmistakably distinguished) rather than blending into the ordinary queued list — avoid the failure mode where a stalled question scrolls out of view behind newer queued prompts.
- [ ] ## Tests
- [ ] Add/update a unit test (see existing `src/renderer/components/__tests__/QueueTicketPanel.test.tsx` for the pattern) covering: a ticket with status `needs-input` renders the distinct treatment, and clicking it triggers the scroll/focus callback.
- [ ] Add/update a test in chat.ts's existing test coverage (search `src/renderer/state/__tests__/chat*` or similar) verifying `onNeedsInput` sets the ticket to `needs-input` rather than `done`, and that a subsequent `send()` on that tab clears it.
- [ ] `timeout 300 npm run typecheck` passes.
- [ ] `timeout 300 npx vitest run` (full unit suite) passes.

# Implementation notes

Read ~/Projects/session-manager/plugins/session-manager-dev/skills/develop/standards.md before starting.

Prior research in this repo established the following (verify current line numbers before editing, they may have drifted):
- Sentinel + IPC: `src/main/chatRunner.cjs` — `STOP_SENTINEL = '<<<SM_NEEDS_INPUT>>>'` (~line 57), parsed ~line 78-80, broadcast as `chat:run:needs-input` (~line 37) with payload `{ tabId, sessionId, questions, answerBody, raw }` (typed in `src/preload/api.d.ts` ~line 1075-1083).
- Renderer subscription: `src/renderer/state/chat.ts:392` `window.api.chat.onNeedsInput(...)`, pushes a `role: 'question'` turn (~line 410-421) into the SAME `turns` array as normal chat bubbles — there is no separate modal component anywhere in `src/renderer/components`, despite the user colloquially calling it a "modal."
- Inline rendering: `src/renderer/components/TerminalChat.tsx` `Turn` renderer, ~line 459-475 — amber card, "❓ Needs your answer", question list, hint text "Reply in the composer below to answer."
- Composer: `TerminalChat.tsx` textarea ~line 810, placeholders ~line 816. `submit()` ~line 598-619 calls `send({ tabId, sessionId, cwd, prompt: draft })`; `sessionId` is the tab's persistent `useSessions` session id (~line 561), NOT anything answer-specific — this is already correct/sufficient for routing, don't rebuild it.
- `send()` in `src/renderer/state/chat.ts` ~line 186+: if tab not `running`, dispatches `chat:run` with `resume: true`; if `running`, queues a `PromptTicket`.
- `PromptTicket` interface: `src/renderer/state/chat.ts:48-59`. Status enum currently `'queued' | 'running' | 'dispatched-to-prd' | 'done' | 'failed'` (~line 54).
- `src/renderer/lib/ticketDisplay.ts` maps ticket status to a display tone, currently reusing the scheduler's `PrdDisplayStatus` shape (`'queued' | 'running' | 'dispatched' | 'completed' | 'failed'`) — needs a new branch for `needs-input`.
- `QueueTicketPanel` component: `TerminalChat.tsx` ~line 340-430ish (definition), rendered ~line 790-801.

This is UI/status-clarity work on top of already-correct session routing — do not introduce a new answer-targeting IPC call or a `respondTo` field; the existing `sessionId`-based resume is sufficient and correct today per the research above.

# Out of scope

- Building a real modal/dialog for needs-input — keep it inline in the transcript + Prompt Queue panel as today, just with correct status and a scroll/focus affordance
- Any change to chatRunner.cjs's sentinel protocol or payload shape
- Multi-question branching UI (answering questions one at a time, structured forms per question) — out of scope, the existing free-text reply-via-composer mechanism is unchanged

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).

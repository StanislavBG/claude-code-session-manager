---
title: PromptTicket type + per-tab chat queue + chatRunner manual-send FIFO
cwd: ~/Projects/session-manager
estimateMinutes: 20
---
# Goal

Add a per-tab prompt queue so a user can keep typing prompts into the Turn-panel chat while one is running, instead of the input being silently dropped. Introduce a PromptTicket record type, extend the `chat.ts` zustand store's `TabChat` with a FIFO queue of tickets, and extend `chatRunner.cjs`'s existing FIFO lane (already used for silent/automated runs) to also serialize manual/user sends per tab so queued tickets execute one at a time through the same mechanism rather than a second queue.

# Acceptance criteria

- [ ] Define a `PromptTicket` type (in `src/renderer/state/chat.ts` or a shared types file it imports) with fields: `id` (string, client-generated stable UUID via `crypto.randomUUID()`), `tabId`, `sessionId`, `cwd`, `text`, `status: 'queued' | 'running' | 'dispatched-to-prd' | 'done' | 'failed'`, `createdAt: number`, `startedAt?: number`, `completedAt?: number`, `prdSlugs?: string[]`.
- [ ] `TabChat` in `src/renderer/state/chat.ts` (around line 43-53) gains a `queue: PromptTicket[]` field, initialized to `[]` wherever `TabChat` is currently constructed.
- [ ] In `send()` (`chat.ts` ~line 134-163), replace the current hard-block `if (cur.running) return` (line 138) with: if `cur.running` is true, construct a new `PromptTicket` with status `'queued'` and push it onto `cur.queue` instead of returning early — the prompt text must NOT be dropped.
- [ ] When the currently-running turn completes (wherever `running` is set back to `false` in `chat.ts`), if `queue.length > 0`, dequeue the oldest ticket (FIFO), set its status to `'running'` and `startedAt`, and invoke the same send path used for a fresh manual prompt (reusing existing logic, not a duplicate code path) so it runs through chatRunner exactly like an immediate send.
- [ ] In `src/main/chatRunner.cjs`, the existing FIFO lane (`~line 269-354`, currently only admitting silent/automated runs per its own docblock at lines 13-21) is extended so manual sends for a given `tabId` are also admitted through the same serialized lane, respecting the existing `SM_CHAT_CONCURRENCY` cap — do not introduce a second/parallel queue mechanism.
- [ ] Add a unit test in the renderer test suite (co-located per existing convention, e.g. `chat.test.ts` or extending an existing one) covering: sending a second prompt while `running === true` pushes to `queue` instead of being dropped, and that completing the running turn dequeues and starts the next queued ticket in FIFO order.
- [ ] `npm run typecheck` passes.
- [ ] `timeout 120 npx vitest run <path-to-chat-store-test-file>` passes.

# Implementation notes

Read these files first: `src/renderer/state/chat.ts` (TabChat shape ~lines 43-53, `send()` ~lines 134-163, the `chats: Record<string, TabChat>` store ~line 60), and `src/main/chatRunner.cjs` (docblock lines 3-40 explains today's split between the silent-run FIFO at ~lines 269-354 and the manual-send bypass at ~lines 336-354 per PRD 493). The existing FIFO/concurrency-cap machinery (`CONCURRENCY_CAP`, `SM_CHAT_CONCURRENCY`) must be reused, not duplicated — this PRD only changes which sends are admitted to it, not how the lane itself works. Do not touch `exchanges.cjs` or PRD frontmatter in this PRD — that is the next PRD in this sequence, queued to run serially after this one lands, since it depends on the `PromptTicket.id` type this PRD introduces.

# Out of scope

- exchanges.cjs promptId persistence (next PRD)
- PRD frontmatter sourcePromptId field (next PRD)
- Turn-panel queue side-panel UI / status rendering (final PRD)
- Any classification/routing logic for chatRunner vs /develop (next PRD)
- Cross-tab or global queue coordination — this is strictly per-tab

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).

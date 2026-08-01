---
title: Never silently drop an Epic chat send in chatRunner's per-tab exclusivity guard
cwd: /home/bilko/Projects/session-manager
estimateMinutes: 12
---
# Goal

A user's Epic chat message can be swallowed with no error and no way to recover. `run()` in src/main/chatRunner.cjs:381 returns early when `opts.tabId` is already in `inFlight` or `waiting`, emitting no broadcast at all, while `ipcMain.handle('chat:run')` (chatRunner.cjs:817) still resolves `{ ok: true }`. The renderer already set `running: true` at src/renderer/state/chat.ts:438, so the Epic is wedged in the running state forever with no toast and no completion event. A `silent` /context probe (chatRunner.cjs:196) occupying the same tabId is enough to trigger this. Fix the guard so a colliding send is either queued behind the in-flight run or reported as an error — never dropped.

# Acceptance criteria

- [ ] ## Core functionality
- [ ] - [ ] `run()` in src/main/chatRunner.cjs no longer returns silently on a tabId collision. When `inFlight.has(opts.tabId)` or `waiting.some(w => w.tabId === opts.tabId)`, a NON-silent run is enqueued behind the existing work for that tabId rather than discarded, preserving FIFO order within the tab.
- [ ] - [ ] `run()` returns a discriminated result (e.g. `{ accepted: true }` / `{ accepted: false, reason: 'tab-busy' }`) instead of `undefined`, and `ipcMain.handle('chat:run')` at chatRunner.cjs:817 returns that outcome instead of an unconditional `{ ok: true }`.
- [ ] - [ ] When a send genuinely cannot be accepted, main broadcasts `chat:run:error` (or an equivalent already-listened-for event, see src/renderer/state/chat.ts:801) for that tabId so the renderer clears `running` and surfaces a toast. No code path leaves the renderer's `running: true` with no terminal event.
- [ ] ## Edge cases
- [ ] - [ ] A `silent: true` probe run (chatRunner.cjs:196) colliding with a tabId still does NOT broadcast to the renderer — silent runs stay invisible per the existing rule at chatRunner.cjs:413-414. A silent probe that collides is dropped as before; only user-initiated sends get the new queue/error behavior.
- [ ] - [ ] A user send arriving while a silent probe holds the tabId is queued and dispatched once the probe settles — it is not lost and does not race the probe's `--resume` against the same sessionId.
- [ ] ## Interaction / integration
- [ ] - [ ] The PRD-831 invariant is preserved: the guard must still prevent two concurrent `claude -p --resume` runs against the same sessionId. Queuing must not become concurrency.
- [ ] - [ ] The cross-tab `CONCURRENCY_CAP` / sessionSlots.acquire path in `pump()` (chatRunner.cjs:389-408) is unchanged.
- [ ] ## Tests
- [ ] - [ ] New vitest cases cover: (a) a user send colliding with an in-flight run is queued and later dispatched, (b) the ipc handler's return value reflects rejection, (c) a rejected send broadcasts a terminal event, (d) a silent probe collision broadcasts nothing.
- [ ] - [ ] `timeout 300 npm run typecheck` passes.
- [ ] - [ ] `timeout 300 npm run test:unit` passes.

# Implementation notes

Read src/main/chatRunner.cjs first — the relevant region is `run()` at :377-385, `pump()` at :389-417, `broadcast()` at :356, and the ipcMain registrations in `registerChatHandlers()` at :814-840. `executeRun`/`inFlight` bookkeeping is above.

Renderer side for context (do NOT restructure it in this PRD): src/renderer/state/chat.ts `send` at :281-323 (its own `cur.running` PromptTicket queue at :292-315), `dispatchSend` at :411-456 which sets `running: true` at :438 and calls `window.api.chat.run(...)` at :445-451. Preload bridge: src/preload/index.cjs:382 (`chat:run` invoke) and :418 (`chat:run:error` listener).

Note the renderer ALREADY has its own per-tab queue keyed on `cur.running`, so the main-process collision only happens when the renderer's view of `running` disagrees with main's — exactly the silent-probe case. Prefer reusing the existing `waiting[]` array plus a per-tab ordering check over inventing a second queue structure.

Existing tests: src/renderer/state/__tests__/chat.test.ts and any chatRunner spec under src/main. Note src/renderer/state/__tests__/chat.test.ts:1089-1106 already exercises the epicTerminal attach guard — follow that file's mocking style.

Gotcha: `SM_CHAT_CONCURRENCY=3` may be exported in the developer's ~/.bashrc and makes chatRunner specs red locally while green headless — unset it before trusting a failure.

# Out of scope

- Changing the renderer's PromptTicket queue semantics in chat.ts
- Touching the epicTerminal attach guard at chat.ts:287
- Raising or reworking CONCURRENCY_CAP / sessionSlots
- Any UI/rendering work — that is a sibling PRD

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).

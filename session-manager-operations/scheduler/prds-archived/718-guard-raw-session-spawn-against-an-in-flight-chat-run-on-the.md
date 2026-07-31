---
title: Guard raw-session spawn against an in-flight chat run on the unified sessionId
cwd: ~/Projects/session-manager
estimateMinutes: 20
---
# Goal

PRD 717 (must land first — this PRD depends on it) collapses Terminal tab's Chat mode and "Open raw session" onto one shared `sessionId` per tab instead of two independent ids. That unification introduces one real race that did not exist before: `chatRunner.cjs`'s headless `claude -p --resume <sessionId>` run can stay alive for up to its 30-minute `KILL_CEILING_MS`, and nothing stops the user from clicking "Open raw session" (`wakeTab`) mid-run — which would spawn a SECOND live `claude --resume <sessionId>` process (the raw pty) against the exact same session id and transcript file while the first is still writing to it. Add a guard so opening a raw session cancels any in-flight chat run for that tab and waits for it to fully settle before the pty spawns. The reverse direction (Chat sending while a raw pty is alive) is already impossible: `Terminal.tsx`'s `isDormant` conditional only renders `TerminalChat` while dormant and the raw xterm only while not, so no additional guard is needed there.

# Acceptance criteria

- [ ] `src/main/chatRunner.cjs`'s `chat:cancel` IPC handler is changed from `ipcMain.on` (fire-and-forget) to `ipcMain.handle`, and resolves only once the cancelled run's terminal event has actually fired (i.e. after `settle()` runs for that tabId) — reuse the existing `inFlight` Map / `settle()` closure inside `executeRun`; do not add a second parallel tracking structure. If there is no in-flight or waiting run for the tabId, the handler resolves immediately (no-op, same as today).
- [ ] `src/preload/index.cjs`'s `chat.cancel` changes from `ipcRenderer.send('chat:cancel', ...)` (fire-and-forget) to `ipcRenderer.invoke('chat:cancel', ...)`, returning a Promise. Update the type in `src/preload/api.d.ts` (`cancel: (tabId: string) => void` → `cancel: (tabId: string) => Promise<void>`).
- [ ] `useSessions.wakeTab(id, modelOverride?)` in `src/renderer/state/sessions.ts`: before resolving the startup command and flipping the tab to `spawning`, checks whether a chat run is in flight for that tab id (via the chat store — `useChat.getState().chats[id]?.running`, imported from `src/renderer/state/chat.ts`). If running, calls `await window.api.chat.cancel(id)` and awaits it before proceeding with the rest of `wakeTab`'s existing logic. If not running, proceeds exactly as before (no added await, no behavior change on the common path).
- [ ] When `wakeTab` interrupts an in-flight chat run this way, a toast fires (reuse the existing `useToast`/`toast.info` helper already used elsewhere in this codebase, e.g. `TerminalChat.tsx`) with a message such as "Cancelled the in-progress chat run to open a live session." This must NOT fire on the common path where no chat run was running.
- [ ] New test added to `src/main/__tests__/chat-cancel-terminal.test.cjs` (extend the existing file — it already stubs a long-running `claude` child via `SM_CLAUDE_BIN` and drives the real spawn/cancel path) OR a new sibling test file if the existing one's structure doesn't fit: asserts that invoking the (now `handle`-based) `chat:cancel` IPC returns/resolves only AFTER the run's terminal broadcast (`chat:run:error` with 'run cancelled') has fired, not immediately on SIGTERM.
- [ ] New test added to `src/renderer/state/__tests__/sessions.test.ts`: `wakeTab` awaits `window.api.chat.cancel(tabId)` when the tab's chat entry has `running: true` in the chat store before flipping tab status to `spawning`; a second case asserts `wakeTab` does NOT call `chat.cancel` when the tab's chat is idle/not running.
- [ ] `npm run typecheck` passes.
- [ ] `timeout 120 node --test src/main/__tests__/chat-cancel-terminal.test.cjs` passes.
- [ ] `timeout 120 npx vitest run src/renderer/state/__tests__/sessions.test.ts` passes.

# Implementation notes

Read `src/main/chatRunner.cjs` in full first, specifically `executeRun`'s `settle()` closure (frees `inFlight`, resolves the run's own internal promise) and the existing `cancel(tabId)` function (SIGTERM→SIGKILL via the registered `cancelFn`, or drops a still-`waiting` queued run). The `handle`-based version needs to return a promise that resolves when settle() actually runs for that tabId — the simplest correct approach is to have `run()`'s per-job promise (already created via `executor(opts)` in both the manual and FIFO-pump paths) be resolvable/awaitable from `cancel()`'s call site; consider keeping a `tabId -> settlePromise` alongside the existing `inFlight` Map (or reusing `inFlight`'s value shape) rather than inventing an unrelated mechanism. Keep the change minimal — this is a synchronization primitive, not a redesign of the queue.

Read `src/renderer/components/Terminal.tsx` (`isDormant` conditional, lines ~235-239) to confirm/cite why the REVERSE direction (raw pty alive while Chat tries to send) is already structurally impossible and needs no new guard — `TerminalChat` only mounts while `isDormant`, and sending is only reachable through `TerminalChat`'s `submit()`.

Read `src/renderer/state/sessions.ts`'s current `wakeTab` (post-PRD-717, it operates on the unified `sessionId` field) and `src/renderer/state/chat.ts` for the chat store's shape (`chats[tabId].running`) before wiring the check.

This PRD depends on PRD 717 (`717-unify-chat-and-raw-session-identity-into-a-single-sessionid.md`) having landed first — it assumes the unified `sessionId` field already exists. If for any reason PRD 717 has not yet run when this PRD executes, stop and report `needs_review` rather than re-deriving the unification inline.

# Out of scope

- Guarding `sleepTab` → re-entering Chat mode: pty.kill() is near-instant relative to a chat run's up-to-30-minute window, and `sleepTab`'s synchronous `set()` call flips status to dormant (re-mounting TerminalChat) only after the kill IPC is fired, which is an accepted, pre-existing ordering — no new guard needed.
- Any change to chatRunner.cjs's CONCURRENCY_CAP FIFO lane, silent-probe handling, or the 30-minute KILL_CEILING_MS — unrelated to this guard.

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).

---
title: External prompt-enqueue: main-process IPC push into a tab's chat queue + admin route + MCP tool
cwd: ~/Projects/session-manager
estimateMinutes: 25
---
# Goal

Today, a prompt can only be added to a tab's chat queue (PromptTicket, PRD 748/750) by the renderer itself calling useChat's send() locally — there is no way for main-process code (Web Remote, an external MCP caller, or a future scheduler hook) to push a prompt into a specific open tab's queue. Add that capability end-to-end: a main-process function that resolves a tabId and pushes {tabId, prompt} to the renderer over IPC, a renderer-side listener that reuses the EXISTING useChat.getState().send() path (no duplicate queuing logic), a new admin HTTP route exposing it for external callers, a new MCP tool wrapping that route, and a new webRemote.cjs command wiring the phone client into the same underlying function in-process.

# Acceptance criteria

- [ ] Add a new main→renderer IPC channel, e.g. `chat:external-send` (broadcast via the existing per-window webContents.send pattern used elsewhere in src/main — check index.cjs for how other broadcasts like `transcript:event:<tabId>` are sent), carrying `{ tabId: string, prompt: string }`.
- [ ] In src/renderer/state/chat.ts, register a listener for this channel (near where other IPC-driven mutators are wired, e.g. near patch() at chat.ts:227) that resolves the tab's current sessionId/cwd from the existing useSessions store (see TerminalChat.tsx:449 for an example of reading useSessions.getState()) and calls useChat.getState().send({ tabId, sessionId, cwd, prompt }) directly — do NOT reimplement the queued-vs-immediate branching already in send() (chat.ts:185-211); if the tab is unknown/closed, no-op and log via window.api.logs.write('chat', 'warn', ...).
- [ ] Add a main-process function `enqueueExternalPrompt(tabId, prompt)` (new small module or added to chatRunner.cjs/index.cjs — follow existing file organization conventions in src/main) that sends the IPC broadcast above to the focused/main BrowserWindow. Export it so other main-process modules can call it directly without IPC (mirroring how docEdit.cjs:203 already calls chatRunner.run() directly, per src/main/docEdit.cjs:24).
- [ ] Add a new admin HTTP route registered via the same registerRoute(method, url, handler) pattern scheduler.cjs already uses (see scheduler.cjs:3361-3383, src/main/lib/localAdminHttp.cjs:78-100), e.g. `POST /admin/chat/send-prompt` with body `{ tabId, prompt }`, calling enqueueExternalPrompt. Token-authed the same way existing admin routes are (config at ~/.claude/session-manager/admin-api.json).
- [ ] Add a new MCP tool to scripts/scheduler-mcp-server.cjs (alongside scheduler_reset_job/scheduler_list_jobs/scheduler_create_prd, using the same adminRequest() helper at scheduler-mcp-server.cjs:44-64), e.g. `chat_send_prompt` with input `{ tabId: string, prompt: string }`, calling the new admin route.
- [ ] In src/main/webRemote.cjs, add a new case to the cmd:* dispatch map (webRemote.cjs:1061-1152), e.g. `cmd:chat:send`, that calls enqueueExternalPrompt directly (in-process, no admin HTTP hop needed since webRemote already runs inside the Electron main process) given a tabId + prompt from the paired phone client's payload.
- [ ] Add tests: a renderer test for the new chat.ts IPC listener (mock the IPC event, assert useChat.getState().send() is invoked / the ticket lands in the correct tab's queue or runs immediately per existing send() semantics — do not re-test send()'s own branching logic, that's covered by PRD 748's tests), and a main-process test (or integration test if an existing pattern covers admin routes) for enqueueExternalPrompt resolving to the correct IPC broadcast.
- [ ] npm run typecheck passes.
- [ ] timeout 120 npx vitest run <path-to-new-chat.ts-test> and <path-to-new-main-process-test> pass.

# Implementation notes

Read first: src/renderer/state/chat.ts (PromptTicket type at line 47, TabChat at line 60, send() at line 185, patch() internal mutator pattern at line 227), src/main/chatRunner.cjs (run() at line 332, module.exports at 709-721 — for the pattern of a main-process function other modules call directly, see src/main/docEdit.cjs:24+203), src/main/lib/localAdminHttp.cjs (registerRoute pattern, ~lines 78-100), src/main/scheduler.cjs (registerAdminRoutes at 3361-3383 for the admin-route registration pattern to copy), scripts/scheduler-mcp-server.cjs (existing 3 tools ~lines 67-114, adminRequest() helper at 44-64), src/main/webRemote.cjs (cmd:* dispatch map at 1061-1152 — note webRemote.cjs currently does NOT require chatRunner.cjs at all; this PRD is what adds that link), src/main/sessionsStore.cjs (tabs.json shape: `{ tabs: PersistedTab[] with cwd, activeTabId, savedAt }`) only if resolving tabId→cwd is needed on the main-process side (it generally isn't for this PRD — cwd/sessionId resolution happens renderer-side per the AC above). This PRD is pure plumbing: it does not add any UI, does not add a scheduler-completion hook (that's the next PRD in this sequence, 754, which depends on this one), and does not change send()'s existing queue-vs-immediate branching — it only adds a new caller of send().

# Out of scope

- Scheduler PRD-completion → tab notify hook (next PRD, 754, depends on this one)
- Any UI changes to TerminalChat.tsx or QueueTicketPanel
- Changing chat.ts's send() queue-vs-immediate logic itself
- Web Remote phone-side UI for composing/sending a prompt (out of scope — this PRD only wires the main-process/webRemote.cjs command handler; phone UI is separate)
- Auth/UX changes to the admin API token scheme itself — reuse what exists

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).

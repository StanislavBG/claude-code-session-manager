---
title: Wire chat prompt-queue "develop" classification to actually create a scheduler PRD
cwd: ~/Projects/session-manager
estimateMinutes: 25
---
# Goal

src/renderer/state/chat.ts's dequeueNext() (~line 340-381) already classifies a queued PromptTicket as 'inline' or 'develop' via classifyPromptTicket (src/main/lib/classifyPromptTicket.cjs, called over IPC through src/renderer/lib/promptClassifier.ts's window.api.chat.classifyTicket). When classified 'develop' it marks the ticket status 'dispatched-to-prd' and posts a notice — but per the TODO comment at chat.ts:346-349, nothing actually creates a PRD. src/main/lib/prdCreate.cjs already has buildPrdBody + the create-PRD logic, but it is only reachable via the local admin HTTP route (registerAdminRoute, mounted in src/main/index.cjs:33 against scheduler.remote) used by the MCP tool — there is no renderer-facing IPC path to it. This PRD closes that gap: add an IPC handler the renderer can call directly (no HTTP round-trip), and wire dequeueNext's 'develop' branch to call it, populating the ticket's existing prdSlugs field (already rendered as clickable chips at TerminalChat.tsx:412-424, currently always empty because nothing populates it).

Since a raw ticket's prompt text is not itself a decomposed PRD (title/goal/AC require actual authoring, which is /develop's job, not a background classifier's), this PRD deliberately creates a MECHANICAL/templated draft PRD from the ticket text — not a smart auto-decomposition. The user reviews/edits the draft in the existing Scheduler tab PRD editor before it runs. Smarter automatic authoring is explicitly out of scope (see below).

# Acceptance criteria

- [ ] In src/main/lib/prdCreate.cjs, extract registerAdminRoute's core logic (slug derivation, config.validatePath(expandHome(cwd)) check, NN allocation via remote.allocateParallelGroup unless parallelGroup is given, existing-file collision check via remote.readPrd, buildPrdBody, remote.writePrd) into a single reusable async function e.g. createPrd(input, remote) that both registerAdminRoute's HTTP handler and the new IPC handler call — do not duplicate the validation/write logic in two places (API-reuse standard)
- [ ] Add ipcMain.handle('chat:create-prd', ...) in src/main/index.cjs, validated via schemas.schedulerCreatePrd (src/main/ipcSchemas.cjs:245), calling prdCreate.createPrd(input, scheduler.remote) — the same remote object already passed to prdCreate.registerAdminRoute at index.cjs:33 — so this is an in-process call, never an HTTP round-trip through localAdminHttp.cjs
- [ ] Add window.api.chat.createPrd(payload) to the preload bridge (src/preload/index.cjs, next to the existing classifyTicket entry at line 447) invoking ipcRenderer.invoke('chat:create-prd', payload); update src/preload/api.d.ts with the matching type
- [ ] In src/renderer/state/chat.ts's dequeueNext() 'develop' branch (~line 363-376), replace the TODO with a call to window.api.chat.createPrd with: title = first ~60 chars of ticket.text (trimmed at a word boundary), cwd = ticket.cwd, estimateMinutes = 15, goal = ticket.text verbatim, acceptanceCriteria = ['Implement the request described in Goal.', 'timeout 300 npm run typecheck passes'], implementationNotes = a short string naming the target cwd, sourcePromptId = ticket.id, sourceTabId = ticket.tabId
- [ ] On success, the dispatched ticket's prdSlugs is set to [returned filename without the .md extension] (reuse the existing PromptTicket.prdSlugs field and the existing chip rendering at TerminalChat.tsx:412-424 — do not add new rendering)
- [ ] On failure (IPC rejects or returns a non-ok result), the ticket's status becomes 'failed' (not silently left as 'dispatched-to-prd') and a notice turn is pushed describing the error, following the existing applyError/appendTicketHistory pattern in chat.ts
- [ ] Unit tests in src/renderer/state/__tests__/chat.test.ts extend the existing 'develop' classification tests (~line 401 and ~430) to stub window.api.chat.createPrd and assert: the call args match the mapping above, prdSlugs is populated on success, and status becomes 'failed' with a notice on rejection
- [ ] A new or extended main-process test (mirroring the stub style of src/main/__tests__/classifyPromptTicket.test.cjs and src/main/__tests__/scheduler-notify-originating-tab.test.cjs) covers the chat:create-prd handler: a cwd outside allowedRoots is rejected via config.validatePath before any write, and a valid payload writes through prdCreate.createPrd/remote.writePrd
- [ ] timeout 300 npm run typecheck passes
- [ ] timeout 300 npx vitest run src/renderer/state/__tests__/chat.test.ts passes
- [ ] timeout 300 npx vitest run <the new/extended main-process test file for chat:create-prd> passes

# Implementation notes

Read first: src/renderer/state/chat.ts (PromptTicket type ~line 48-61, dequeueNext ~340-381, appendTicketHistory, applyError), src/main/lib/prdCreate.cjs (buildPrdBody, registerAdminRoute — the logic to extract), src/main/ipcSchemas.cjs (schedulerCreatePrd schema ~line 245, the `validated()` helper used by other handlers), src/main/index.cjs (~line 25-40 where scheduler/prdCreate/adminHttp are wired — add the new ipcMain.handle near the other chat: handlers, not next to admin route registration), src/preload/index.cjs:447 (classifyTicket entry — mirror its shape exactly), src/renderer/lib/promptClassifier.ts (renderer-side wrapper pattern to mirror for a new promptCreatePrd-style helper if you want one, though calling window.api.chat.createPrd directly from chat.ts is also fine and simpler).

scheduler.remote (src/main/scheduler.cjs, exported at the bottom, object defined ~line 3309) already has allocateParallelGroup, readPrd, writePrd — the exact three calls createPrd(input, remote) needs.

Do NOT touch chatRunner.cjs or the scheduler's execution/retry logic — this PRD is purely: PRD-authoring plumbing (IPC handler) + wiring the existing classifier's 'develop' branch to it.

# Out of scope

- Smarter/LLM-authored PRD content (real decomposition of the ticket text into a proper title/goal/multi-line AC) — the mechanical template above is intentional V1 scope; a future PRD can improve authoring quality once this plumbing exists
- Feature/Bug tagging on tickets or PRDs (next PRD in this chain)
- Chaining follow-up prompts onto an already-dispatched ticket's PRD sequence (next-next PRD in this chain)
- Any UI layout changes to QueueTicketPanel/TerminalChat.tsx beyond what's needed for prdSlugs display, which already exists
- Mobile web-remote ticket/queue exposure (webRemote.cjs does not expose ticket state today and this PRD does not change that)

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).

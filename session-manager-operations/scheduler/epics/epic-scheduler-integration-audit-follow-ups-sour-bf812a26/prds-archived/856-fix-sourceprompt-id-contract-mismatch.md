---
title: Fix sourcePromptId contract mismatch between MCP/IPC docs and Epic-join runtime
cwd: /home/bilko/Projects/session-manager
estimateMinutes: 20
---

# Goal

The `sourcePromptId` field on `scheduler_create_prd` (scripts/scheduler-mcp-server.cjs:110) and the equivalent IPC zod schema (src/main/ipcSchemas.cjs:287-291) are documented as "PromptTicket.id this PRD was authored from" — but the actual runtime join logic in src/main/scheduler.cjs (`ensureEpic(cwd, { epicId: fm.sourcePromptId })` around line 4128) and src/main/lib/epicMint.cjs's `ensureEpic` (`index.sessions[explicitEpicId]`) both require `sourcePromptId` to literally equal an Epic's `promptSessionId`, not a `PromptTicket.id`. The renderer internally never confuses these (src/renderer/state/chat.ts:55-89 keeps `PromptTicket.id` and `PromptTicket.promptSessionId` as distinct fields and only ever sends `promptSessionId` as `sourcePromptId`), but any external MCP caller following the published tool description would pass the wrong id, silently minting an unrelated new Epic instead of joining the intended one, and later fail to route the completion notification back (scheduler.cjs `appendResponseEventIfKnown` around line 1658-1663 falls through to the tab/cwd fallback at 1666-1680 — the same identity-confusion class as the tabId bug fixed by PRD 854-external-send-epic-targets-and-dead-channels, but on a different field; do not re-fix that one).

# Acceptance criteria

- [ ] scripts/scheduler-mcp-server.cjs's sourcePromptId description and src/main/ipcSchemas.cjs's zod schema comment are corrected to state it must be an existing Epic's promptSessionId (the id shown in the Epics list / active-index.json sessions key), not a PromptTicket.id
- [ ] A code comment is added at ensureEpic's call site in scheduler.cjs (~line 4128) clarifying that sourcePromptId is expected to be a promptSessionId, cross-referencing epicMint.cjs's join lookup
- [ ] A unit test covers: passing a sourcePromptId that does not match any existing Epic mints a new Epic (documenting current behavior), and passing one that matches an existing Epic's promptSessionId correctly joins it without creating a duplicate
- [ ] `timeout 300 npm run typecheck` passes.
- [ ] `timeout 600 npm run test:unit` passes.

# Implementation notes

Read src/main/scheduler.cjs's writePrd/ensureEpic call chain (~line 4120-4200), src/main/lib/epicMint.cjs's ensureEpic (~line 73-117), src/main/promptSessionEvents.cjs line ~80, scripts/scheduler-mcp-server.cjs line ~110, src/main/ipcSchemas.cjs line ~287-291, and src/renderer/state/chat.ts line ~55-89 for how the renderer keeps these ids distinct.

This is a documentation-and-test correctness fix, not a behavior change — do not alter the join semantics itself unless a test reveals an actual crash; only correct the docs/schema comments and add coverage.

# Out of scope

- Changing the actual join/mint semantics of ensureEpic
- Fixing the tabId-vs-promptSessionId bug already covered by PRD 854

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).

---
title: Resolve external chat sends against Epics, and remove the dead chat context-probe channels
cwd: /home/bilko/Projects/session-manager
estimateMinutes: 14
dependsOn: [prompt-session-event-broadcast]
---
# Goal

Any externally-originated prompt aimed at an Epic is silently ignored. src/renderer/state/chat.ts:812-818 resolves the target via `useSessions.getState().tabs.find(t => t.id === tabId)`, but Epics are PromptSessions in usePromptSessions, not SessionTabs — so every Web Remote, loopback admin-API, and MCP `chat_send_prompt` call targeting an Epic id hits the `if (!tab)` branch at :814 and logs "external send ignored: tab <id> is not open". src/main/scheduler.cjs:1666-1680 uses the same fallback lookup. Separately, `ipcMain.handle('chat:probe-context')` (chatRunner.cjs:835) and `broadcast('chat:context-usage')` (chatRunner.cjs:210) have no preload counterpart in src/preload/index.cjs and are dead in both directions. Fix the first; resolve the second one way or the other.

# Acceptance criteria

- [ ] ## Core functionality
- [ ] - [ ] The `chat:external-send` handler in src/renderer/state/chat.ts:812-818 resolves a target that is an Epic (a PromptSession in src/renderer/state/promptSessions.ts) as well as one that is an open SessionTab, and dispatches the send with that Epic's `claudeSessionId` and `cwd`.
- [ ] - [ ] The same resolution gap in src/main/scheduler.cjs:1666-1680 is fixed so a scheduler-originated status prompt can route back to the Epic it was dispatched from.
- [ ] - [ ] When neither a tab nor an Epic matches the id, the existing ignore-with-log behavior is kept, but the log message names both lookups so the failure is diagnosable.
- [ ] ## Edge cases
- [ ] - [ ] An external send targeting a COMPLETED/archived Epic is refused rather than resuming a dead claudeSessionId (see the archived-Epic rule in CLAUDE.md: an archived Epic's claudeSessionId is dead).
- [ ] - [ ] An external send targeting an Epic whose Terminal view is currently attached respects the existing mutual-exclusivity guard at src/renderer/state/chat.ts:287 rather than racing the PTY.
- [ ] ## Interaction / integration
- [ ] - [ ] Resolution respects the store-island rule — do not make promptSessions.ts and sessions.ts cross-subscribe; compose the lookup at the point of use in chat.ts using `getState()`, as the existing code already does for useSessions.
- [ ] - [ ] Dead channels resolved: either wire `chat:probe-context` (src/main/chatRunner.cjs:835) and `chat:context-usage` (chatRunner.cjs:210) through src/preload/index.cjs to a real renderer consumer, or delete both the handler and the broadcast. Do not leave a half-wired channel.
- [ ] - [ ] Stale references to the retired `PromptSessionConversation.tsx` (removed in PRDs 827/829) are corrected in: CLAUDE.md:12, src/renderer/components/epics/EpicComposer.tsx:80, src/renderer/components/epics/EpicDetail.tsx:255, and src/renderer/state/chat.ts:545 and :572 — point them at EpicDetail.tsx / EpicComposer.tsx instead.
- [ ] ## Tests
- [ ] - [ ] Vitest coverage for: external send resolving to an Epic, resolving to a SessionTab, refusing a completed Epic, and being ignored (with the improved log) when neither matches.
- [ ] - [ ] `timeout 300 npm run typecheck` passes.
- [ ] - [ ] `timeout 300 npm run test:unit` passes.

# Implementation notes

Read: src/renderer/state/chat.ts :281-323 (`send`, incl. the epicTerminal guard at :287) and :812-818 (the `chat:external-send` listener); src/renderer/state/promptSessions.ts (session shape, `claudeSessionId` minted at :167, status field); src/renderer/state/sessions.ts (the tabs array being searched today); src/main/scheduler.cjs :1659-1680; src/main/chatRunner.cjs :196-215 (silent probe + context-usage broadcast) and :814-840 (handler registrations); src/preload/index.cjs :382-436.

External entry points that feed `chat:external-send`: src/main/webRemote.cjs, src/main/adminServer.cjs, and the MCP tool `chat_send_prompt` in scripts/scheduler-mcp-server.cjs. Check each to confirm the id they pass is the Epic id (PromptSession.id) and not the claudeSessionId — the domain model says Epic id and claudeSessionId are distinct, and getting this backwards is the whole bug.

Depends on 853 (prompt-session-event-broadcast) only for ordering: that PRD establishes the promptSession event/broadcast plumbing this one routes against. Read its landed state before starting — it may have adjusted where session lookup helpers live.

Before deleting the probe-context/context-usage channels, grep the whole repo (including src/renderer/lib/useChatSignals.ts and any web-remote frontend) to confirm there is genuinely no consumer. If a consumer exists, wire the channel instead of deleting.

Do not write interactive/GUI acceptance criteria — a headless claude -p run cannot drive the Electron GUI. Do NOT launch a second Electron instance to verify.

# Out of scope

- Adding new external-control capabilities or relaxing webRemote's remoteControlEnabled tiering
- Changing the Epic/claudeSessionId domain model
- Live chat streaming/tool chips (sibling PRD)
- The chatRunner per-tab drop guard (sibling PRD)

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).

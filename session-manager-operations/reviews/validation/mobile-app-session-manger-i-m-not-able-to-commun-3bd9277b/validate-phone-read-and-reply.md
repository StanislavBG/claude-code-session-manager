# Validation: phone read-and-reply plan (PRDs 2094–2100, 2107–2109, 2111)

Base: `26f7f7a9` (given). Plan commits: d261f8f1, cd8ad94b, 1fb3402f, 700b7e41, e505cb49, bad9581d, c8844fd5, 2ed949fe (2107), 1e9582f8 (2108), 2986eebf (2109), 4060a376 (2111's work, landed under 2110). Combined diff: 36 files, +1700/−241 (includes unrelated macro-input commits in the range).

## Gates re-run (all green)
- `npx vitest run` on remoteTranscriptTail, web-remote-session-transcript, web-remote-multi-client, web-remote-session-watch, web-remote-pty-stream, chatRunner-external-send-ack, scheduler-notify-originating-tab, web-remote-chat-send, renderer chat.test.ts: 9 files, 141 tests passed (scratch TMPDIR).
- `npm run typecheck` (root): exit 0.
- `npm --prefix web/remote-app ci && run typecheck && test`: typecheck 0; 24 files / 154 tests passed.

## Per-PRD

### 2094-remote-conversation-builder — VERIFIED
- `remoteTranscriptTail.cjs:15-18` constants (2000/16000/20/100000); `:106` `buildRemoteConversation`; uuids `ex:<ts>:u/a` `:142-143`; empty side skipped via `if (prompt)/(result)`; live only when `b === 0` with ts > newest, last 20 `:118-132`; `hasMore`/`nextBefore` `:154`; byte budget live-first then exchanges newest-first `:113-151`; export `:157`. Tests in remoteTranscriptTail.test.cjs pass.

### 2095-preload-external-send-result-api — VERIFIED
- `api.d.ts:1650` `requestId?`, `:1653-1659` types + `ChatExternalSendResult`, `:2312` `reportExternalSendResult`; `index.cjs:540` invokes `chat:external-send-result`. Typecheck green.

### 2096-phone-api-conversation-and-send-result — VERIFIED
- `remoteApi.ts` `getTranscript` (before only when given, normalises page), `sendChat` (refused→RemoteError(refusalMessage), missing disposition→unconfirmed), `refusalMessage` copy matches criteria exactly. `types.ts` has `live?`, `TranscriptPage`, `SendChatResult`. Suite green.

### 2097-remote-transcript-serves-conversation — VERIFIED
- `ipcSchemas.cjs:975-980` `before` 0..10000, limit 1..100. `webRemote.cjs` `cmd:session:transcript`: tab id/sessionId→`tab.sessionId`, else Epic by id/claudeSessionId; `listExchanges({limit:limit+1, offset:before})`; tail only when `before===0`; unresolvable → `{messages:[],hasMore:false,nextBefore:null}`; cwd/validatePath checks kept first. Test file passes.

### 2098-renderer-reports-external-send-result — VERIFIED
- `chat.ts` exports `ChatSendResult`; `send` returns empty-prompt / terminal-attached / queued / sent; `onExternalSend` reports every branch (tab, Epic, payload fallback, completed, unknown-target) guarded by `typeof requestId === 'string'` with try/catch + `.catch`. chat.test.ts passes.

### 2099-phone-session-screen-conversation — VERIFIED
- No `SummaryPane` reference remains. `SessionScreen.tsx:13-14` POLL_MS 4000 / MAX 45; labels `:17-19`; `:112` pending cleared when a user message includes the prompt; `:162` `session-refresh`; `:193` `session-load-earlier`. `MicPane.tsx:12,94` `onSent`. Phone suite green.

### 2100-remote-session-watch-main-and-relocate — VERIFIED
- `cmd:session:subscribe` resolves tab by id+cwd → `tab.sessionId`; `startSessionWatch(tabId,cwd,sessionId=tabId)`; `pollSessionWatcher` re-resolves path when file missing and resets offset/inode. Absence check: no `maybeSummarize`, `event:session:summary`, `summarizedMsgId`, `lastAssistantText`, `summarize.cjs` require in webRemote.cjs (diff shows all removed). Tests pass.

### 2107-external-send-ack-registry — VERIFIED
- `ipcSchemas.cjs:965` schema, exported `:1368`. `chatRunner.cjs` `EXTERNAL_SEND_ACK_TIMEOUT_MS=8000`, pending Map, `enqueueExternalPrompt` returns promise (requestId via randomUUID, timeout→unconfirmed/timeout, no window→unconfirmed/no-window, never rejects), `settleExternalSend` ignores unknown ids, handler registered through `validated(...)`, admin route uses `void`. Ack test passes.

### 2108-remote-chat-send-returns-disposition — VERIFIED
- `cmd:chat:send` awaits `enqueueExternalPrompt`, returns `{ok, disposition, reason?}`; non-active Epic → refused proposed/not-active; no match → refused unknown-target; `auditResultFor` logs `refused:<reason>`. MUTATE/SAS gates untouched. Test passes.

### 2109-phone-delete-summary-pane — VERIFIED
- `SummaryPane.tsx` absent; grep of `web/remote-app/src` for SummaryPane/summaryByTab/setTabSummary/SessionSummary/event:session:summary → no matches. Suite 154 green.

### 2111-phone-drop-summary-state — VERIFIED
- The scheduler job for 2111 was a duplicate of 2110 and made no commit, but the work exists: commit 4060a376 removes `summaryByTab`/`setTabSummary`/`SessionSummary` (store.ts, App.tsx offSummary + deps, types.ts) and trims store.spec.ts. All criteria hold on the tree; gate green.

## Contract cross-check
- `chat:external-send-result` payload `{requestId, disposition, reason?}` matches in api.d.ts, preload, ipcSchemas (same enums), chatRunner handler/`enqueueExternalPrompt`, and chat.ts listener.
- `cmd:chat:send` reply `{ok, disposition, reason?}` ↔ `sendChat`; main's `unconfirmed`/`proposed`/`not-active` are handled by `refusalMessage`/the unconfirmed branch.
- `cmd:session:transcript` page text capped at 100,000 bytes (≈133 KB after base64) < 256 KB relay cap.

## Findings
Critical: none.

Important: none.

Minor:
1. Stale queued fix PRD `prds/2111-fix-phone-drop-summary-state.md` (duplicate-slug guard for `createPrd`) is still unrun; it explains the duplicate 2110/2111 and is not part of this plan's acceptance.
2. `SessionScreen.tsx:112` clears the pending bubble only when a loaded user message includes the full prompt, but exchange prompts are capped at 2000 chars (`remoteTranscriptTail.cjs:142`) — a longer prompt's bubble would linger. Exchanges are also only written after a turn completes, and polling stops after 45×4 s = 3 min, so a long turn can outlast the polling window (Refresh button covers it).
3. `remoteTranscriptTail.cjs:136-150`: a single over-budget newest exchange yields an empty history with `hasMore:true` (unreachable in practice: max ≈54 KB for 2000+16000 chars).
4. Phone bundle in 2109/2111 not yet published to bilko.run (as noted in the task); desktop side ships with next npm publish.
5. Self-review (no separate /code-review run): no secrets, input is zod-validated, paths re-validated with `validatePath`, no new helpers duplicated.

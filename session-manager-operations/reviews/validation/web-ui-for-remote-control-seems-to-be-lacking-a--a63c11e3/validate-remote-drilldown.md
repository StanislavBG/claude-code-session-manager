# Validation: remote drill-down plan (1902–1917)

Base: f2aaffc8a5e2240231858b115dae3923c6f1d266 (HEAD 4442a4ba). 15 commits in range, 34 files, +1929/−404.
All PRD files found under `prds-archived/`. Node modules for root gates: symlinked from the main checkout (untracked, gitignored); phone gates: `npm --prefix web/remote-app ci`.

## Gates re-run (foreground)
- Root vitest (all PRD root gate files: remoteDrilldown, remoteTranscriptTail, chat.test, webRemoteDrilldown, webRemoteAgentReads, webRemoteEpicList, ipc-web-remote, webRemoteAuthGate, webRemoteSasState, web-remote-multi-client, web-remote-e2e-pinning): 11 files / 205 tests passed.
- `npm run typecheck` exit 0; `npm run lint` exit 0; `npm run lint:docs` ok.
- `npm --prefix web/remote-app run typecheck` exit 0; `npm --prefix web/remote-app test`: 16 files / 76 tests passed (act() warnings only in session-screen.spec).
- `grep -rn 'event:session:list' src/main` → none.

## Per-PRD verdicts
- **1902-remote-drilldown-builders — VERIFIED.** `src/main/lib/remoteDrilldown.cjs` (91 lines, commit 9bb569de) + test; gate green.
- **1903-remote-transcript-tail — VERIFIED.** `src/main/lib/remoteTranscriptTail.cjs` + test (16ba5b5a); gate green.
- **1904-phone-remote-api-client — VERIFIED.** `web/remote-app/src/remoteApi.ts` sends the 5 cmd types; sendChat payload `{ tabId: target, prompt }` (remoteApi.ts:68-69); remote-api.spec passes.
- **1905-phone-bundle-vendor-script — VERIFIED.** `vendor-to-bilko.mjs` throws on missing index.html/manifest/parent, rm's `assets` before cp, returns `{copied}`; `web/remote-app/CLAUDE.md` 2593 chars (<4000); vendor spec 3 tests pass; lint:docs ok.
- **1906-external-send-unloaded-epic — VERIFIED.** chat.ts handler + chat.test.ts (commit 2f4462b9); chatRunner.cjs passes only `sessionId`/`cwd` extras; typecheck/lint/test green.
- **1909-remote-drilldown-commands — VERIFIED.** ipcSchemas.cjs schemas (`remoteProjectSessions`, `remoteSessionTranscript` with charset regex + limit 1..100) and SAS_GATED_READS entries (ipcSchemas.cjs:1190-1194); dispatch handlers webRemote.cjs:1064-1107; webRemoteDrilldown.spec green.
- **1910-remote-ready-replaces-list-push — VERIFIED.** pushSessionList/startSessionListPush/SESSION_LIST_PUSH_MS/_sessionListTimer/lastSessionListJson removed (diff); `finalizeE2eAuthenticated` pushes `event:remote:ready` only with a client and remoteEnabled (webRemote.cjs ~771); buildRemoteSessionList/cmd:sessions:list intact; grep for event:session:list clean.
- **1911-phone-projects-screen — VERIFIED.** `ProjectsScreen.tsx` + projects-screen.spec pass.
- **1912-phone-sessions-screen — VERIFIED.** `SessionsScreen.tsx` + sessions-screen.spec pass.
- **1913-phone-session-screen — VERIFIED.** `SessionScreen.tsx` (sendTarget = epicId / mainTabId, SessionScreen.tsx:25; subscribe cwd spawnCwd||projectCwd) + MicPane explicit target; session-screen.spec and updated tests pass.
- **1914-remote-chat-send-resolves-target — VERIFIED.** webRemote.cjs:1215-1238: open tab → as before; active Epic by id/claudeSessionId → `enqueueExternalPrompt(epic.id, …, {sessionId, cwd})`; proposed/completed/unknown throw. Cases in webRemoteDrilldown.spec pass.
- **1915-remote-session-prds-command — VERIFIED.** webRemote.cjs:1109-1126 (cwd open-tab check, epic existence, filter/sort/cap 50) + schema + SAS_GATED_READS; tests pass.
- **1916-phone-drilldown-routing — VERIFIED.** store route/go*/bumpRefresh, Cockpit renders by route, SessionNav.tsx deleted, no remaining `SessionNav|SessionMeta` references in web/remote-app/src; store/await-desktop-confirm/drilldown-routing specs pass.
- **1917-phone-app-remote-ready — VERIFIED.** `markRemoteReady`, `event:remote:ready` listener with deviceId check, `createReadyFallback` 20 s timer armed on sas:pending, cleared on ready and in effect cleanup (App.tsx diff); remote-ready.spec passes.

## Cross-PRD contract check — PASS
- remoteApi.ts cmd types (`cmd:projects:list`, `cmd:project:sessions`, `cmd:session:transcript`, `cmd:session:prds`, `cmd:chat:send`) all have handlers in webRemote.cjs getDispatchMap (lines 1064/1071/1083/1109/1215) and are in ipcSchemas.cjs tier sets (SAS_GATED_READS 1190-1194; `cmd:chat:send` in the mutate tier at 1219).
- Payload fields match: `cwd`, `sessionKey`, `limit`, `epicId`, `tabId`, `prompt` on both sides (zod schemas vs remoteApi.ts).
- sendChat targets are epicId / mainTabId (SessionScreen.tsx:25); never claudeSessionId.
- No emitter of `event:session:list` remains in src/main.

## Review of combined diff (self-review; no unsafe input found)
Paths: sessionKey/epicId restricted by charset regex (no `/`), cwd must equal an open tab's cwd and passes `validatePath`; transcript file resolved only via tab main id or Epic index. Secrets: none. New commands are SAS-gated.

### Findings
- Critical: none.
- Important: none.
- Minor:
  - `src/main/webRemote.cjs:1119` `known` check also tests `!!sessions[parsed.epicId]`; a charset-valid key like `constructor` resolves via the prototype and passes as "known" (result is simply an empty `prds`). Use `Object.hasOwn`.
  - `src/main/webRemote.cjs:1222`/`1226` `cmd:chat:send` calls `readActiveIndex` for every open tab sequentially on a miss; fine at current scale.
  - `web/remote-app/src/__tests__/session-screen.spec.tsx` emits React act() warnings (noise only).

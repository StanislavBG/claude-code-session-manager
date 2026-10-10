# Validation: remote Epic control (PRDs 1767, 1768)

Base: 07ad77be (known). Commits: 6590c36a (1767), 3ebdaa2f (1768). PRD files found in `prds-archived/`.

## web-remote-session-list-includes-epics (1767) — VERIFIED
- `buildRemoteSessionList(tabs, readIndex)` exported via `__test` — `src/main/webRemote.cjs:638`, `:1340`.
- Project entry shape `{kind,tabId,cwd,title,project}` — `webRemote.cjs:646`; Epic entry shape — `:660-669` (cwd = `worktree?.dir || cwd`, title = first line, trimmed, max 80, fallback `epic.id`, plus project/tag/agentType).
- Only `status==='active'` with non-empty `claudeSessionId` — `:653-655`; dedupe by Epic id via `seenEpics` — `:656-657`.
- readIndex throw/no sessions → project entry alone, never throws — `:647-649` (try/catch + `continue`).
- `pushSessionList` uses `buildRemoteSessionList(data.tabs, readActiveIndex)` and merges watcher state by tabId — `:684-690`; kill-switch / `_e2e.state !== 'authenticated'` guard untouched (`:681`). `readActiveIndex` already exported — `src/main/lib/epicMint.cjs:449`, so that file needed no change.
- Spec `tests/unit/webRemoteEpicList.spec.ts` present.
- Gate (re-run): `vitest run webRemoteEpicList + webRemoteCommandSets + webRemoteAuthGate` → 3 files, 26 tests passed; `npm run typecheck` exit 0 (needed the main checkout's `node_modules` symlinked temporarily, since the job worktree has none; symlink removed).

## remote-app-epic-nav-and-chat-send (1768) — VERIFIED
- `SessionMeta` gains `kind, epicId, project, tag, agentType`, existing fields unchanged — `web/remote-app/src/types.ts:55-59`.
- `MicPane.send()` looks up session by tabId, errors `Session no longer available` and sends nothing if missing, else `cmd:chat:send` with `{tabId: s.epicId ?? s.tabId, prompt: data}`, no newline; no `cmd:pty:write` left — `MicPane.tsx:76-86`.
- `SessionNav` groups by `s.project ?? projectName(s.cwd)`, project entry first (`kindRank`), labelled `Main`, Epic card shows title and tag in place of tabId slice — `SessionNav.tsx:25-35, 84-85`.
- Spec `epic-nav-chat-send.spec.tsx` covers (a),(b),(c) plus missing-session case: 4 tests pass.
- Gate (re-run): `npm --prefix web/remote-app ci` ok, `typecheck` ok, `test` → 8 files, 27 tests passed.

## Cross-checks
1. Emitted Epic entry fields (kind, tabId, epicId, cwd, title, project, tag, agentType) match the new optional `SessionMeta` fields read by web/remote-app. Match.
2. Phone sends `tabId = epicId`; `src/renderer/state/chat.ts:1393-1410` `onExternalSend` checks open tabs first, then `usePromptSessions.getState().sessions[tabId]`, and sends with the Epic's `claudeSessionId`/`cwd`. Match.
3. Epic data only flows through `pushSessionList` (SAS-gated; only caller sites `webRemote.cjs:703,704,752`); `'cmd:chat:send'` still in `MUTATE_COMMANDS` — `src/main/ipcSchemas.cjs:1177`. No new command or ungated push.

## Combined diff review
6 files, +181/−12; only PRD-listed files touched. No secrets, no path handling on untrusted input (cwd values come from local index files, not the phone), no new commands. `/code-review` and `/security-review` not run; self-reviewed.

## Findings
### Critical
- none
### Important
- none
### Minor
- `src/renderer/state/chat.ts:1401-1407`: a send to a `completed` Epic is dropped with only a log line; the phone shows success. Unreachable via the list (completed Epics are excluded) except in a race between list pushes.
- `web/remote-app/src/components/MicPane.tsx:77-78`: `sessions` is captured in the closure on each render; fine, but a list refresh while typing re-resolves correctly only on next render.
- Stray untracked `<path>` file in the worktree is the known sqlite MCP placeholder; not part of this plan.

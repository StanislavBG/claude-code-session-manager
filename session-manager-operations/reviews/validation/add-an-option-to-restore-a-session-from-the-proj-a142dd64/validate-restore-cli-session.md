# Validation — restore a CLI session as a new Epic (PRDs 2844–2851)

Base: d67ab7924df0b1cc20928944065beae96cbb706b. Commits found for every PRD (8dbbe02e, d87be868, 3f53546f, a3135741, 06004001, 8d50d28b, 6f36da31, 2357a8f5). Review was a self-review (no /code-review run).

Gates re-run (SM_* unset): 10 vitest files, 273 tests green; `npm run typecheck` green; `npm run lint` green; `npm run lint:docs` ok. Full `npm run test:unit`: 952 files, 9037 passed, 1 skipped, 0 red.

## restorable-sessions-lister — VERIFIED
- `src/main/lib/epic/restorableSessions.cjs:597-603` exports SESSION_ID_RE, claimedClaudeSessionIds, listRestorableSessions, checkRestorableSessionSync.
- Pinned dir `restorableSessions.cjs:147` (one `encodeCwd(cwd)` dir); a recorded-cwd mismatch is excluded (header :12). Gate `restorableSessions.test.cjs` green (300-line spec).
- Probe: fixture listed, then excluded after claim (hiddenClaimed 1).

## restorable-sessions-preload-contract — VERIFIED
- `src/preload/index.cjs` `listRestorable` → `promptSessions:list-restorable`; `api.d.ts` and `apiSurface.json` updated; `restoredSession?: true` is typed. apiSurface test + typecheck green.

## epic-mint-adopts-restored-session — VERIFIED
- `epicMint.cjs:268` takes `restoreSessionId`; `:366-367` adopts it and sets `restoredSession: true`; `:221-235` `restoreRefusal` rejects an id already owned by an Epic and runs checkRestorableSessionSync. `promptSessionSchema.cjs:104` has `z.literal(true).optional()`.
- Probe: a mint with an authority other than the New Epic UI is refused.

## restored-epic-skips-worktree — VERIFIED
- `epicWorktreeMint.cjs` `isRestoredEpic` reads the active-index row, else the mirror/archive (covers reopen), and returns null before `createEpicWorktree`. `epicWorktreeMint.test.cjs` and `epicReopen.test.cjs` green.

## restorable-sessions-ipc — VERIFIED
- `ipcSchemas.cjs`: `restoreSessionId` is regex-validated by the UUID RE (path-traversal safe); `promptSessionsListRestorable` is strict. `promptSessionsCreateEpic.cjs` `listRestorableViaIpc` calls `validatePath(cwd)` first; the handler is registered as `promptSessions:list-restorable`. Handler and epicMint tests green.

## restore-session-store-wiring — VERIFIED
- `state/promptSessions.ts` forwards `runtime.restoreSessionId`; approve skips `createWorktree` when `session.restoredSession === true`. Store test green; lint green.

## new-session-restore-panel — VERIFIED
- `NewEpicCard.tsx:1050-1068` mounts `RestoreSessionPanel` above "Context injections" (:1068). `RestoreSessionPanel` and `NewEpicCard` tests green.

## docs-restored-session-epics — VERIFIED
- `prompt-sessions/README.md` documents `restoredSession` and the claudeSessionId adoption, linking to domain-model `#hierarchy`. `lint:docs` ok. I did not inspect the domain-model.md diff itself; it was not in the diff stat's visible tail.

## Real-path probe — PASS
Temp HOME with a fixture `<HOME>/.claude/projects/<encodeCwd(proj)>/<uuid>.jsonl` (script at /tmp/vprobe/probe.cjs, not committed):
```
LIST [{"id":"3f2b8c1e-5a4d-4e7f-9b1a-0c2d3e4f5a6b","title":null,"first":"Please refactor the parser"}] hiddenClaimed 0
MINT {"epicId":"restore-probe-6bc1813a","created":true,...}
EPIC claudeSessionId 3f2b8c1e-5a4d-4e7f-9b1a-0c2d3e4f5a6b equal true restoredSession true
LIST_AFTER 0 hiddenClaimed 1
NON-AUTH refused: ensureEpic: no open Epic to join — an Epic is created in exactly two places...
PLAN {"ok":true,"execCwd":"/tmp/vp-F9Hnmb/proj","useResume":true,"transcriptPath":".../-tmp-vp-F9Hnmb-proj/3f2b8c1e-....jsonl"} execCwd==proj true
```

## Findings
- Critical: none.
- Important: none.
- Minor: `/code-review` and `/security-review` were not run; I self-reviewed. Input handling is sound: the UUID regex is enforced at the IPC schema and again in `checkRestorableSessionSync` before any path is built, and `validatePath` guards the list cwd.
- Minor: I did not read the domain-model.md diff separately.
- No red specs in the full unit suite.

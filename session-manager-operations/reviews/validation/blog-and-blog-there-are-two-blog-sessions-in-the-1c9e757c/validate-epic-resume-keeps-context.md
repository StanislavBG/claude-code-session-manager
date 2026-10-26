# Validation: epic-resume-keeps-context (Base 51eb7ce0..HEAD)

Gates re-run (SM_* unset): combined vitest of all PRD gate specs = 13 files / 219 tests passed; `npm run typecheck` clean; `npm run lint` clean; `npm run lint:docs` ok. `grep -rn resumeArchived src` → clean.
Commits: f09026c4 (2303), 4099109d (2304), 0704d100 (2305), 65702eaa (2306), 7bc19d96 (2307).

## epic-transcript-reachable-restore — VERIFIED
- epicTranscriptRestore.cjs exports hasTranscriptSource/ensureEpicTranscriptReachable; its test file (reachable/copied/sidecar/missing/invalid-id/never-overwrite) passes in the gate run.

## epic-reopen-in-place-main — VERIFIED
- epicReopen.cjs: tombstone deleted, same id/claudeSessionId, status active, completedAt null inside withPathLock(activeIndexPath) (doReopen ~L100-112); mirror rewritten wholesale with archivedAt null and no session/events (L113-121).
- Worktree branches in provisionWorktree (L25-52); hasTranscriptSource precheck before any write (L88), ensure after worktree (L94); alreadyOpen short-circuit (L63) and inFlight map (L131+).
- ipcSchemas.cjs:236 promptSessionsReopen strict, exported (L1363); handler calls validatePath first; activeIndexMerge.cjs header names reopenEpic (L31 area).

## epic-reopen-ipc-wiring — VERIFIED
- index.cjs:1028 single register call after epicWorktreeMerge (L1027); preload/index.cjs:586; api.d.ts:2324; tests/unit/epicReopenWiring.spec.ts passes.

## epic-resume-reopens-same-session — VERIFIED
- promptSessions.ts:752 reopenEpic (unknown id throws, active/proposed returns w/o IPC, ok:false throws result.message, ok:true replaces row+events, emits epic_resume for same id); no create call in it; no `resumeArchived` anywhere in src.
- EpicDetail.tsx:957 Resume → reopenEpic(epicId,'EpicDetail'), disabled/“Resuming…”, toast on error; EpicQueue.tsx:323 Reopen → reopenEpic then onSelect(epic.id), toast on error.
- End-to-end intent holds: one Epic, same id/claudeSessionId, no new-Epic path reachable from reopenEpic.

## epic-reopen-lifecycle-docs — VERIFIED
- README completed row, Reopen item 4 (new, three-states rule kept), resumedFromId legacy comment, retention mention; domain-model.md Persistence bullet links lifecycle. Grep for "dead"/"mints a new session" in both files: none. lint:docs ok.

## Findings
- Critical: none. Important: none.
- Minor: epicReopen.cjs ~L88-91 on missing transcript calls ensureEpicTranscriptReachable only to name the error (no spawnCwd) — works but redundant with a direct fail(); no behavior issue.
- Minor: no real-Electron/E2E exercise of the IPC path was run (gate is unit/static only).
- Code/security self-review: cwd passes validatePath, epicId regex-constrained, claudeSessionId regex-checked in restore; no path traversal or secrets found.

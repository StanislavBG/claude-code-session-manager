---
title: active-index writes: main-side merge IPC under epicMint's path lock + removal tombstones (cross-window safety)
cwd: /home/bilko/Projects/session-manager
estimateMinutes: 20
sourcePromptId: psess-msbv6w4d-10
dependsOn: [active-index-lost-update-protection]
---
# Goal

Code review of the 2026-08-02 Epic-lockdown work (commits 92280db..f8b5c8a) confirmed persistActiveIndex's read-merge-write (src/renderer/state/promptSessions.ts:~320-360) stops single-window wipes but left two cross-process holes: (1) no removal tombstone — a second window still holding an archived Epic as 'active' in memory resurrects it on its next persist (memory-wins spread), leaving the Epic in both the active index and its archive JSON; (2) the renderer's read→merge→write runs outside epicMint.cjs's withPathLock (epicMint.cjs:~211), so a proposal minted by the main process between the renderer's read and write can still be lost (TOCTOU narrowed to milliseconds, not eliminated). Close both by routing renderer index writes through a main-side merge IPC that holds the same path lock and honors a persisted removal set.

# Acceptance criteria

- [ ] ## Core functionality
- [ ] New IPC (zod-validated in src/main/ipcSchemas.cjs, registered like existing config channels) that accepts {cwd, sessions, events, removedIds, source:'epics'} and performs the read-merge-write in the MAIN process inside the same withPathLock epicMint.cjs uses for that active-index path — shared lock instance, not a second lock map.
- [ ] Removal tombstones: ids in removedIds are recorded (e.g. a small removedAt map inside active-index.json or a sibling file owned by the same writer) so a later merge from ANY window drops a tombstoned session id from its memory contribution instead of resurrecting it; tombstones for an id are cleared if that id is legitimately re-created (resumeArchived mints a NEW id today — confirm and state in a comment).
- [ ] src/renderer/state/promptSessions.ts persistActiveIndex delegates to the new IPC (its event-union merge semantics from commit 3d12e19 + the per-id event union added 2026-08-02 move main-side unchanged); renderer-side read-merge code is deleted, not kept as a fallback.
- [ ] Single-writer law: the IPC handler writes as the 'epics' writer via config.cjs writeJson — opsOwnership delegation table untouched (scheduler's own delegated writes keep working).
- [ ] ## Edge cases
- [ ] Two simulated windows: window A markCompleted(epic X) then persists; window B (still holding X 'active' in memory) persists afterwards → X stays gone from active-index and remains archived (named regression test for the resurrection hole).
- [ ] Mint-during-persist: an ensureEpic mint interleaved with a renderer persist (drive both through the shared lock in a test) → the minted Epic survives.
- [ ] ## Tests
- [ ] Unit tests: main-side merge handler (vitest, src/main/__tests__/), updated renderer store tests still pass: timeout 300 npx vitest run src/renderer/state/__tests__/promptSessions.test.ts src/main/__tests__/epicMint.test.cjs
- [ ] timeout 300 npm run typecheck passes

# Implementation notes

Read first: src/renderer/state/promptSessions.ts persistActiveIndex (~:300-365 — note the pendingWritesByPath FIFO chaining and the per-id event UNION added after review finding #2; keep both semantics), src/main/lib/epicMint.cjs (withPathLock ~:211, ensureEpic write path, appendAuditEvent), src/main/lib/opsOwnership.cjs (delegations), src/main/ipcSchemas.cjs + src/main/index.cjs (channel registration pattern), src/main/config.cjs (writeJson atomic write, writer enforcement). Prior link (941-active-index-lost-update-protection) delivered: renderer-side read-merge-write with removedIds parameter and corrupt-disk fallback, commit 3d12e19; this PRD moves that merge main-side and adds tombstones. Keep the IPC payload small: renderer sends only its per-cwd memory maps + removedIds; main owns disk truth. Fire the same 'epics' writer string. Do not build CRDTs or file locks across processes beyond the existing in-process withPathLock — Electron main is the single process serializing all writers (renderer via IPC, scheduler delegation, epicMint), which is the whole point of moving the merge there.

# Out of scope

- Multi-machine sync
- Changing archive file format
- chat.ts dispatch logic
- Audit log changes

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).

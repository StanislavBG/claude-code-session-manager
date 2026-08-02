---
title: active-index lost-update protection — persistActiveIndex must merge with disk, never drop Epics it didn't remove
cwd: /home/bilko/Projects/session-manager
estimateMinutes: 18
sourcePromptId: psess-msbv6w4d-10
---
# Goal

Incident 2026-08-02: Epics psess-msbuw5t5-5 and psess-msbuwt8p-7 (created 13:48/13:49 UTC) were silently ERASED from session-manager-operations/prompt-sessions/active-index.json — no archive file written — when a renderer whose in-memory sessions map had not hydrated them did a full-map persistActiveIndex write at ~13:57 (the same write that persisted the rogue Epic). The domain law says an Epic is never erased; only markCompleted (archive) or deleteEpic remove one. Make persistActiveIndex (src/renderer/state/promptSessions.ts:~265-300) merge-safe: a write may add/update sessions and remove only ids it explicitly intends to remove (completed/deleted), never drop a session merely because it isn't in renderer memory.

# Acceptance criteria

- [ ] ## Core functionality
- [ ] persistActiveIndex (or a wrapper all its callers use) reads the current on-disk index immediately before writing and merges: disk sessions/events not present in memory are preserved verbatim; memory entries win on id collision; an explicit removal set (from markCompleted/deleteEpic) is the ONLY way an id disappears from the written file.
- [ ] markCompleted still archives-then-removes and deleteEpic still hard-removes — both keep working, expressed through the explicit removal mechanism.
- [ ] ## Edge cases
- [ ] A renderer that boots with an empty store and immediately creates one Epic writes an index that still contains all pre-existing on-disk Epics plus the new one (this is the exact incident shape — make it a named regression test).
- [ ] Merge also preserves the events map for preserved sessions (the incident dropped events too).
- [ ] Corrupt/unreadable disk index during merge falls back to writing memory state with a logged warning (no crash, no data-dependent throw).
- [ ] ## Interaction / integration
- [ ] The scheduler's delegated writes to active-index.json (opsOwnership delegation) are unaffected — confirm the merge happens renderer-side only and doesn't fight the scheduler's writer path (read src/main/lib/opsOwnership.cjs DELEGATIONS before touching anything).
- [ ] ## Tests
- [ ] Unit tests in src/renderer/state/__tests__/promptSessions.test.ts covering: incident-shape preservation, explicit removal still removes, event-map preservation, disk-win-vs-memory-win rules.
- [ ] timeout 300 npm run typecheck passes
- [ ] timeout 300 npx vitest run src/renderer/state/__tests__/promptSessions.test.ts passes

# Implementation notes

Read first: src/renderer/state/promptSessions.ts (persistActiveIndex ~:265-300 — currently serializes the whole in-memory map via window.api.config.writeJson(path, index, 'epics'); hydrate() ~:519 best-effort one-shot merge from disk; markCompleted; deleteEpic; renameEpic), src/main/lib/opsOwnership.cjs (delegation table: scheduler may write prompt-sessions/active-index.json). Keep the single-writer law intact — this stays the 'epics' writer; the fix is read-merge-write within that writer, not a new writer. window.api.config has a readJson/readText path used by hydrate() — reuse it. Note the write itself is atomic (tmp+rename in config.cjs); the hazard being fixed is the stale in-memory read-modify-write, not torn writes. If concurrent renderer writes are possible (multiple windows), a simple re-read-just-before-write plus explicit-removal-set closes the practical hole; do not build a full CRDT/locking scheme.

# Out of scope

- Locking/CRDT or multi-process mutexes
- Changing the scheduler's delegated write path
- chat.ts dispatch logic (PRD 940)
- Recovering the two lost Epics (already restored by hand 2026-08-02)

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).

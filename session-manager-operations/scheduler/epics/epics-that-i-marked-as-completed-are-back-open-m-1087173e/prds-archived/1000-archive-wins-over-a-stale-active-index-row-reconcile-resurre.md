---
title: Archive wins over a stale active-index row: reconcile resurrected Epics at hydrate
cwd: /home/bilko/Projects/session-manager
estimateMinutes: 40
sourcePromptId: epics-that-i-marked-as-completed-are-back-open-m-1087173e
dependsOn: [998-fix-silent-epic-write-rejection-register-a-project-root-befo]
---
# Goal

Once an Epic has an archive file on disk AND a leftover row in active-index.json, it is shown Open forever with no self-healing path: hydrate() loads the active-index row as status 'active', and hydrateArchived() then skips it outright (`if (sessions[id]) continue`), so the archive is never read. Two Epics in this repo are in exactly that state right now (psess-mscdnslc-10, psess-mscg8i3u-2 — both archived 2026-08-03 with status 'completed', both still listed as 'active' in active-index.json with no tombstone). Make the archive authoritative so a partially-failed completion heals itself on the next load instead of demanding the user re-complete the Epic forever.

# Acceptance criteria

- [ ] hydrateArchived (state/promptSessions.ts) no longer skips an id already in memory when that in-memory row came from the active index and an archive file exists: the archive wins and the Epic renders as Completed
- [ ] The reconciliation also removes the stale row from disk and records a tombstone, via the existing mergeActiveIndex removedIds path — no new write mechanism, no direct fs write
- [ ] The reconciliation is one-shot per id and idempotent: a second hydrate pass over the same cwd performs no further writes (assert the merge IPC is not called again)
- [ ] An in-memory Epic with unsaved local state and NO archive on disk is untouched — memory still wins in that case
- [ ] Running the app once against this repo leaves psess-mscdnslc-10 and psess-mscg8i3u-2 out of active-index.json's sessions, present in tombstones, and displayed under Completed
- [ ] Unit tests in src/renderer/state/__tests__/promptSessions.test.ts cover archive-wins, tombstone-written, idempotent-second-pass, and no-archive-memory-wins
- [ ] npm run typecheck and npm run test:unit pass

# Implementation notes

hydrateArchived is at src/renderer/state/promptSessions.ts:689-717; the skip is `if (sessions[id]) continue` (~line 703). hydrate() is at ~614-688. Ordering matters: ProjectsLanding calls hydrate() then hydrateArchived(), so the archive pass must be able to override a row hydrate() just installed — distinguish "came from disk index this pass" from "genuinely local unsaved state" rather than blanket-overriding. Tombstones are written by src/main/lib/activeIndexMerge.cjs from the removedIds field (see its header comment on the resurrection guard). Depends on PRD 998 landing first, otherwise the reconciliation write is itself rejected by the write-boundary check.

# Out of scope

- Hand-editing active-index.json as a one-off repair — the code path must do it
- Changing the archive file format

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).

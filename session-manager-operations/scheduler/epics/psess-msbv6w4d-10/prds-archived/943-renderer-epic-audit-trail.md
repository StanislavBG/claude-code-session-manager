---
title: Renderer epic_mint audit trail — every Epic creation/activation/removal logs to the audit log over IPC
cwd: /home/bilko/Projects/session-manager
estimateMinutes: 15
sourcePromptId: psess-msbv6w4d-10
dependsOn: [epic-store-born-proposed-only]
---
# Goal

The audit log (src/main/lib/auditLog.cjs → ~/.claude/session-manager/audit-log.jsonl) exists to trace a rogue Epic back to its origin, but no preload/IPC exposes it to the renderer — so the 2026-08-02 rogue Epic (created renderer-side) left zero audit trace, and diagnosing the incident required reconstructing from transcripts. Expose a narrow audit-append IPC and emit events from every renderer Epic lifecycle transition: create (proposed), approve (proposed→active), complete/archive, delete, resume, duplicate — each with a `source` describing the initiating surface (NewEpicCard, EpicQueue Run Build, approve bar, etc.).

# Acceptance criteria

- [ ] ## Core functionality
- [ ] New IPC channel (preload + ipcMain handler in src/main, payload validated in src/main/ipcSchemas.cjs with zod like every other channel) that appends an audit event via auditLog.cjs's appendAuditEvent; event kind allowlist enforced main-side (epic_create, epic_approve, epic_complete, epic_delete, epic_resume, epic_duplicate) — renderer cannot write arbitrary kinds.
- [ ] src/renderer/state/promptSessions.ts emits: createPromptSession → epic_create (status proposed, source label passed by caller); approveProposed → epic_approve; markCompleted → epic_complete; deleteEpic → epic_delete; resumeArchived → epic_resume; duplicateEpic → epic_duplicate. Each includes cwd, epicId, and source.
- [ ] ## Edge cases
- [ ] Audit emission is fire-and-forget: an IPC failure logs a console warning and never blocks/rejects the store mutation.
- [ ] ## Tests
- [ ] Unit test for the zod schema + kind allowlist (main side) and a renderer store test asserting createPromptSession/approveProposed fire the audit IPC with correct kind and epicId.
- [ ] timeout 300 npm run typecheck passes
- [ ] timeout 300 npx vitest run src/renderer/state/__tests__/promptSessions.test.ts passes

# Implementation notes

Read first: src/main/lib/auditLog.cjs (appendAuditEvent signature; only two callers today: epicMint.cjs:308, prdCreate.cjs:199), src/main/ipcSchemas.cjs (existing zod-at-boundary pattern), src/main/index.cjs (IPC registration pattern), preload wiring (follow how window.api.config channels are exposed), src/renderer/state/promptSessions.ts. Depends on PRD 939 (epic-store-born-proposed-only) so the emission points match the post-939 store shape (createPromptSession always 'proposed'; duplicateEpic/resumeArchived go through approveProposed). Keep the channel append-only — no read/list IPC (the log stays a main-process/ops file). Mirror the fail-open logging convention: background paths may be logger-only per CLAUDE.md toast rules.

# Out of scope

- A UI for viewing the audit log
- Auditing main-process paths (already covered by epicMint.cjs + PRD 942 refusal events)
- Read/query IPC over the audit file

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).

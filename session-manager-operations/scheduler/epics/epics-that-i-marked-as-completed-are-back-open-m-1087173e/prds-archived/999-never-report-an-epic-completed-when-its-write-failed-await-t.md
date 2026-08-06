---
title: Never report an Epic completed when its write failed: await the persist and surface the error
cwd: /home/bilko/Projects/session-manager
estimateMinutes: 40
sourcePromptId: epics-that-i-marked-as-completed-are-back-open-m-1087173e
---
# Goal

markCompleted flips the in-memory status to 'completed' and fires persistActiveIndex WITHOUT awaiting it; persistActiveIndex swallows every failure into a logs.write('warn') that no user ever sees, and the subsequent archive writeJson rejection propagates into a `void`-discarded promise at EpicDetail.tsx:644. The UI therefore shows the Epic as Completed while nothing reached disk. Make the UI's data-change contract honest: the Epic is only shown Completed once the index removal AND the archive have actually landed, and any failure is surfaced through the toast channel.

# Acceptance criteria

- [ ] state/promptSessions.ts's markCompleted awaits persistActiveIndex before it treats the completion as durable, and awaits the archive write
- [ ] If either write rejects, the in-memory status is rolled back to its prior value (the row stays Open) and toast.error(...) names the Epic and the failure — no silent success
- [ ] persistActiveIndex propagates failure to its caller instead of only logging: keep the logs.write for the trace, but the returned promise must reject (or resolve to an explicit {ok:false}) so callers can react
- [ ] Same treatment for the other three mutations that persist through this path and are currently fire-and-forget: deleteEpic, approveProposed, renameEpic — a rejected write must never leave the UI showing a state disk does not have
- [ ] Every markCompleted call site is updated to handle the rejection: EpicDetail.tsx:644, EpicQueue.tsx:437, EpicApprovalBar.tsx:49, Home.tsx:379 — no bare `void promise`
- [ ] Unit tests in src/renderer/state/__tests__/promptSessions.test.ts cover: merge rejects -> status stays 'active' + toast.error called; archive write rejects -> same; both succeed -> status 'completed' as today
- [ ] npm run typecheck and npm run test:unit pass

# Implementation notes

See src/renderer/state/promptSessions.ts: persistActiveIndex (lines ~347-388) currently returns a promise that always resolves, converting failure into api.logs.write('promptSessions','warn',...). markCompleted (search `markCompleted: async`) calls it un-awaited, then does the archive writeJson last. CLAUDE.md: "Toast is the user-facing error channel — don't swallow errors silently". Keep the existing pendingWriteCounts bookkeeping intact (hydrate()'s goneIds reconciliation depends on hasPendingWrite). Rollback must also restore the optimistic 'closed' event appended just before the status flip, or not append it until the write lands.

# Out of scope

- The addAllowedRoot root-cause fix (separate PRD)
- Redesigning the merge protocol or tombstones

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).

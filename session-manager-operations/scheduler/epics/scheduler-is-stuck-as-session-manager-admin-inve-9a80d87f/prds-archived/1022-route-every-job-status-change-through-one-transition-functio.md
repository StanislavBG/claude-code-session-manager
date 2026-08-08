---
title: Route every job status change through one transition function with a legality table and an audit trail
cwd: /home/bilko/Projects/session-manager
estimateMinutes: 70
sourcePromptId: scheduler-is-stuck-as-session-manager-admin-inve-9a80d87f
dependsOn: [give-the-scheduler-job-entity-a-runtime-schema-and-make-an-i]
---
# Goal

A job's status is assigned at 16 separate sites in scheduler.cjs (lines 723, 1741, 1802, 1808, 1819, 2863, 2908, 2963, 2985, 3072, 3272, 3359, 3457, 3705, 4128, 4166) as bare `j.status = '...'` mutations. There is no transition function, no legality table, and no record of who changed a status or why — so there is nowhere to assert that a transition is legal, and no way for the human to review status transitions after the fact. This is why the 1021/1022 stall was undiagnosable from the app: the only evidence was a heartbeat count. Introduce a single chokepoint for the Job lifecycle, mirroring how epicMint.cjs already owns the Epic's `proposed -> active` transition as the one legal path.

# Acceptance criteria

- [ ] A new exported `transitionJob(job, toStatus, { reason, source })` in src/main/lib/scheduleJobSchema.cjs (or a sibling scheduleJobTransitions.cjs) is the ONLY place a job's status field is assigned
- [ ] An explicit LEGAL_TRANSITIONS table declares the allowed from->to edges (e.g. pending->running, running->completed|failed|needs_review, failed->investigating, investigating->failed|completed, needs_review->pending via reset) and is exported for testing
- [ ] An illegal transition is refused: it does not mutate the job, logs at error level with from/to/reason/source, and increments a counter — it must never throw in a way that kills tickQueue (follow the non-blocking convention dodDrainHook.cjs already uses)
- [ ] All 16 assignment sites in scheduler.cjs are converted to transitionJob calls, each passing a real `reason` and `source` string; a repo grep test asserts no bare `.status = ` assignment on a job object remains outside the transition module
- [ ] Every accepted transition appends one record to the existing ~/.claude/session-manager/audit-log.jsonl with { ts, slug, from, to, reason, source, cwd } — reuse the existing audit writer rather than adding a second log
- [ ] Each job carries a bounded `statusHistory` array (cap ~20 entries, oldest dropped) persisted in queue.json so the transition trail survives a restart and is readable per-job
- [ ] The Scheduler tab's job detail surface renders that statusHistory as a readable from->to/reason/when list, so status transitions can be reviewed in the UI without reading JSON
- [ ] Unit tests cover: a legal transition mutates + audits; an illegal transition refuses + logs + leaves the job untouched; statusHistory caps correctly; the no-bare-assignment grep test fails when a bare assignment is reintroduced
- [ ] npm run typecheck, npm run test:unit, npm run lint all pass

# Implementation notes

Precedent to follow: lib/epicMint.cjs enforces the Epic's single legal transition fail-closed and is the shape to copy. The audit log already exists at ~/.claude/session-manager/audit-log.jsonl (epicMint emits epic_mint_refused there) — find its writer and reuse it; do NOT create a second log file. Be careful with the reset path: adminServer's resetJob (used to repair 1021/1022) flips a job back to pending from needs_review/failed and must remain a legal, audited edge — verify against src/main/__tests__/scheduler-admin-routes.test.cjs which already covers reset semantics including the completed+force guard. Also careful at scheduler.cjs:2908/2963 (`j.status = failedJob.status || 'failed'`) — that assigns a status read from ANOTHER job, so the transition call must validate the resolved value, not assume it. statusHistory adds a field to the persisted job shape, so extend ScheduleJobSchema from the dependency PRD in the same change or the new field will be quarantined by its own validator. Keep queue.json small (see lib/queueHistory.cjs's rationale) — hence the ~20-entry cap.

# Out of scope

- Changing the set of statuses itself
- Reworking the investigation/auto-fix state machine's behaviour — only how its status writes are routed
- Epic/PromptSession transitions

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).

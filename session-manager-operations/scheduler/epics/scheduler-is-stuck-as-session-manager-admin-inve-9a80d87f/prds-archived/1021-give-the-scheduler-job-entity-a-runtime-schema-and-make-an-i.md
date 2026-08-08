---
title: Give the scheduler Job entity a runtime schema and make an invalid row fail loudly
cwd: /home/bilko/Projects/session-manager
estimateMinutes: 55
sourcePromptId: scheduler-is-stuck-as-session-manager-admin-inve-9a80d87f
---
# Goal

On 2026-08-07 two PRDs (1021/1022, social-signals-trader) sat unscheduled for 4+ hours because their queue.json rows carried `"status": "queued"` — a value absent from `ScheduleJobStatus` (src/preload/api.d.ts:363). Every picker filters on `status === 'pending'` exactly (scheduler.cjs:3658; schedulerBatch.cjs:94,167,198,206), so the rows were invisible, and the heartbeat's `counts[j.status] = (counts[j.status]||0)+1` (scheduler.cjs:4770) silently minted a `queued` bucket that made the bad data look like a legitimate state. The Job entity has NO runtime validation: shapeJobs (lib/queueStore.cjs:113) is `JSON.parse` + `Array.isArray` with zero field checks, and writeSplit (line 206-214) writes whatever it read straight back. Contrast the Epic entity, which has a zod schema with a status enum (lib/promptSessionSchema.cjs:58) asserted before it ever reaches disk (lib/epicMint.cjs:243). Give Job the same guarantee Epic already has.

# Acceptance criteria

- [ ] New file src/main/lib/scheduleJobSchema.cjs exports a zod ScheduleJobSchema whose `status` is `z.enum(['pending','running','investigating','completed','failed','needs_review'])`, plus an exported JOB_STATUSES array, modelled on lib/promptSessionSchema.cjs
- [ ] shapeJobs in lib/queueStore.cjs validates every row against ScheduleJobSchema instead of returning the parsed array unchecked
- [ ] A row that fails validation is NOT silently dropped and NOT passed through: it is quarantined into a `state.invalidJobs` array, logged once per slug at error level naming the file, the slug, and the failing field, and counted so it can be surfaced
- [ ] readMergedSync and readMerged both apply the same validation (no async/sync divergence)
- [ ] A unit test in src/main/__tests__/ writes a queue.json containing a row with status 'queued' and asserts it is quarantined, logged, and absent from state.jobs — reproducing the 1021/1022 incident exactly
- [ ] A unit test asserts a fully valid row round-trips through shapeJobs unchanged (no field stripping regression)
- [ ] src/preload/api.d.ts's ScheduleJobStatus union is documented as deriving from JOB_STATUSES, and a test fails if the two lists diverge
- [ ] src/renderer/components/ui/StatusBadge.tsx's local JobStatus type (currently drifted: it has 'unqueued' and is MISSING 'investigating') and SchedulePanel.tsx's FilterStatus are reconciled against the single union, with drift covered by that same test
- [ ] npm run typecheck and npm run test:unit both pass

# Implementation notes

Follow lib/promptSessionSchema.cjs + lib/epicMint.cjs:243 as the working precedent for "zod schema asserted at the main-process boundary" — this PRD is deliberately copying that pattern onto the Job entity, not inventing one. Key files: src/main/lib/queueStore.cjs (shapeJobs line 113, readMergedSync 127, readMerged 154, writeSplit 196), src/preload/api.d.ts:363, src/renderer/components/ui/StatusBadge.tsx:9, src/renderer/components/SchedulePanel.tsx:38. Note queueStore already enforces the single-writer law via assertOpsWrite (lines 56/64) — that guard is in-process only and cannot stop an agent writing queue.json with the Write tool, which is exactly why an ON-READ gate is the fix. Do NOT make an invalid row throw and halt scheduling: readMergedSync's existing `unreadable` semantics deliberately halt on a corrupt FILE, but one bad row among good ones must not stop the other projects' work — quarantine, log, continue. Renderer cannot import a .cjs, so the union must live in the .cjs schema and be mirrored (with a drift test), not imported.

# Out of scope

- Centralizing the 16 scattered `.status =` assignment sites — that is the sibling transition-table PRD
- Changing what prdCreate.cjs's HTTP response returns — separate PRD
- Any change to the Epic/PromptSession schema

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).

---
title: Close the PRD-to-queue sync gap: stop the create API reporting a fake status, self-heal orphan rows, and detect a stalled queue
cwd: /home/bilko/Projects/session-manager
estimateMinutes: 65
sourcePromptId: scheduler-is-stuck-as-session-manager-admin-inve-9a80d87f
dependsOn: [give-the-scheduler-job-entity-a-runtime-schema-and-make-an-i]
---
# Goal

A PRD is supposed to be a sub-object of the scheduler, created and managed by the scheduler MCPs — but it is not, and three concrete gaps let it drift out of sync. (1) `scheduler_create_prd` never creates a queue row: it POSTs to /admin/scheduler/create-prd, prdCreate.cjs writes only the .md file, and then returns `{ status: 'queued' }` (lib/prdCreate.cjs:243) — a status that does not exist in ScheduleJobStatus. The scheduler's own agent-facing API hands out the exact invalid string that wedged jobs 1021/1022, which is the most likely way it entered queue.json. (2) reconcile (scheduler.cjs:1305) is add-only: `if (seen.has(slug)) continue` means an existing row is never repaired, so one bad row shadows its PRD permanently. (3) Nothing detects the resulting stall — the queue sat with 2 jobs, 0 running, 0 pending for 4+ hours and the only symptom was a heartbeat count of an invented bucket. Make the create path honest, the reconcile self-healing, and the stall loud.

# Acceptance criteria

- [ ] lib/prdCreate.cjs:243 no longer returns `status: 'queued'`; it returns a field that is true by construction (e.g. { nn, filename, prdPath, epicId, enqueued: false, note: 'row is derived by the next reconcile pass' }) so no caller can copy a fake job status out of the response
- [ ] scripts/scheduler-mcp-server.cjs's scheduler_create_prd tool description and returned text state plainly that the PRD file is written and the queue row is derived on the next reconcile tick — never that the job is 'queued'
- [ ] reconcile in scheduler.cjs repairs rather than skips: an existing queue row whose status fails ScheduleJobSchema is reset to 'pending' (via the transition function if that PRD has landed, else directly), logged at warn level with the old value, and audited — the 1021/1022 rows would have self-healed within one tick
- [ ] A PRD .md file that exists on disk with no corresponding queue row, and no terminal history/run-sidecar entry, is reported — the existing add path already covers it, so add a log line and a count when reconcile has to create a row for a PRD older than one poll interval
- [ ] The heartbeat in scheduler.cjs:4770 initialises counts from the known status union instead of `counts[j.status] = (counts[j.status]||0)+1`, and routes any out-of-union value into an explicit `unknown` bucket rather than minting a new key
- [ ] A stall detector: when the merged queue holds jobs but has 0 running AND 0 pending AND is not paused for a full poll interval, log at error level with a per-project breakdown and emit one non-repeating toast to the renderer — the condition that was silent for 4+ hours must be visible in the app
- [ ] A unit test reproduces the incident end to end: seed a queue.json row with status 'queued', run reconcile, assert the row is repaired to 'pending', the repair is logged, and the stall detector fires for the pre-repair state
- [ ] npm run typecheck, npm run test:unit, npm run lint all pass

# Implementation notes

Files: src/main/lib/prdCreate.cjs (line 243), scripts/scheduler-mcp-server.cjs (create_prd tool at ~line 90-120 and its handler at ~line 169), src/main/scheduler.cjs (reconcile's `if (seen.has(slug)) continue` at line 1306, the entry construction at 1361-1379, heartbeat at 4767-4777, maybeLaunchWhenAvailable at 3655-3667). Read the long comment block at scheduler.cjs:1307-1338 before touching reconcile: a stricter Epic-registration gate shipped there once and caused a 6-hour silent outage across 23 PRDs on 2026-08-01, and the lesson recorded in that comment is that an invisible failure mode is worse than a permissive one — the repair path added here must be loud and must never make MORE PRDs unschedulable. Do not confuse the repair with resurrection: a slug with a terminal history entry or a terminal run sidecar (historyBySlug / latestTerminalOutcomeForSlug, lines 1339-1360) must still be left alone, or completed work re-executes. For the stall toast use the existing toast IPC channel (see the Toast convention in CLAUDE.md) and rate-limit it so a genuinely idle-but-nonempty queue does not toast every 60s. Note the billing meter is currently 429-ing continuously (consecutiveFailures was 114 during the incident) and takes the meter_rate_limited branch at scheduler.cjs:3792 which fires anyway at utilization 0 — that is working as designed and is NOT part of this PRD's scope, but do not let the stall detector misfire on it.

# Out of scope

- Making scheduler_create_prd write the queue row synchronously — the derived-row design is deliberate; this PRD makes it honest and self-healing, it does not invert the ownership
- Fixing the billing meter 429s
- Migrating PRDs out of the retired flat scheduler/prds/ layout

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).

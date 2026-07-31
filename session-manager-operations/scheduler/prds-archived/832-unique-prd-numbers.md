---
title: Unique per-project PRD numbers; parallelism via dependsOn; origin-session linkage
cwd: ~/Projects/session-manager
estimateMinutes: 22
sourcePromptId: prd-numbers-globally-unique-per-project-parallel-0f4c06e0
---

# Goal

Retire the "same NN = parallel group" convention (user decision 2026-07-31: duplicate PRD
numbers must be impossible). Every PRD in a project gets a strictly-unique, monotonically
increasing number — even when multiple sessions/MCP callers author concurrently — parallel
scheduling is expressed through explicit dependencies instead of shared numbers, and every
PRD carries the session that originated it (its Epic's `claudeSessionId`, since an Epic IS
a tagged claude session per the CLAUDE.md domain model).

# Acceptance criteria

## Core functionality

- [ ] `allocateParallelGroup` in `src/main/scheduler.cjs` (reached via
  `src/main/lib/prdCreate.cjs`) becomes/gains `allocateNextPrdNumber(cwd)`: strictly unique
  per project — never returns a number already used by ANY PRD across
  `scheduler/epics/*/prds/`, `prds-archived/`, queue rows, or history; atomic under
  concurrent callers (keep the existing reservation mechanism, drop only the reuse
  semantics). The `parallelGroup` input on `schemas.schedulerCreatePrd` and the MCP tool is
  rejected or ignored with a deprecation note — callers can no longer opt into a duplicate.
- [ ] Scheduling: the queue picker (`pickNextBatch` in `src/main/scheduler.cjs`) no longer
  groups by equal NN. Eligibility = every slug in the job's `dependsOn` (frontmatter
  `dependsOn: [<slug>, ...]`, already a `ScheduleJob` field — see `src/preload/api.d.ts:376`)
  is completed; eligible jobs run lowest-number-first up to the concurrency cap. A PRD with
  no `dependsOn` is immediately eligible. Ingest parses `dependsOn` from frontmatter if it
  doesn't already.
- [ ] Origin linkage: `createPrd`/ingest resolve the Epic's `claudeSessionId` (from the
  project's `session-manager-operations/prompt-sessions/active-index.json` via
  `src/main/lib/epicMint.cjs` helpers) and stamp it on the job row as `originSessionId`
  alongside `sourcePromptId`; exposed through the schedule state payload so the renderer can
  show it.
- [ ] In-flight compatibility: existing queued jobs that DO share numbers (the 82x redesign
  batch) keep executing in their current order — the picker change must treat legacy
  same-number pending jobs as "no dependsOn, lowest-number-first", which preserves their
  wave order without a migration.

## Docs (authoring convention — same repo)

- [ ] `src/main/templates/PRD_AUTHORING.md` AND the live copy at
  `~/.claude/session-manager/scheduled-plans/PRD_AUTHORING.md`: replace the "same NN = may
  run in parallel / next NN = depends" guidance with unique numbers + `dependsOn`
  frontmatter; `plugins/session-manager-dev/skills/develop/SKILL.md` step-4 NN guidance
  updated to match (allocation via the MCP tool; fallback = max+1 which is now always
  unique).

## Tests

- [ ] Unit tests: allocator never reuses under two concurrent allocations (existing PRD 548
  race test extended); picker runs dependsOn-free jobs in number order up to cap and holds a
  job until its dependsOn completes; legacy same-number pending jobs keep order. Bounded run:
  `timeout 300 npx vitest run <files>`; `timeout 300 npm run typecheck` passes.

# Implementation notes

Read first: `src/main/scheduler.cjs` (`allocateParallelGroup`, `pickNextBatch`, ingest),
`src/main/lib/prdCreate.cjs`, `src/main/lib/queueStore.cjs`, `src/main/lib/epicMint.cjs`
(`activeIndexPath`), `src/main/ipcSchemas.cjs` (`schedulerCreatePrd`). The filename prefix
stays `NN-` (now unique); do NOT rename existing files. Keep the change mechanical — this
is allocation + eligibility, not a queue-store redesign. The 82x batch may still be running
while this executes: do not touch queue.json by hand; all changes go through the existing
store/mutate helpers.

# Out of scope

- Renumbering or renaming any existing PRD file.
- Renderer UI for dependsOn editing (frontmatter-only for now).
- Cross-project number uniqueness (per-project is the scope).

## Engineering standards

Before writing any code, read
`/home/bilko/Projects/session-manager/plugins/session-manager-dev/skills/develop/standards.md`
— it has the Performance, Debugging, API-reuse, TDD, and Execution-discipline rules that apply
to this PRD. Every rule in it is mandatory, especially Execution discipline (bounded commands,
verify before done, the finish-protocol sentinel).

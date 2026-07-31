---
title: Scheduler: per-project PRD storage, discovery, and migration
cwd: ~/Projects/session-manager
estimateMinutes: 25
---

# Goal

Introduce a shared per-project PRD discovery helper so the scheduler reads/writes PRDs from
each active project's own `<cwd>/session-manager-operations/scheduler/prds/` directory instead
of the single global `~/.claude/session-manager/scheduled-plans/prds/` (`PRDS_DIR` in
`src/main/scheduler.cjs:289`). This is PRD 1 of a 4-PRD chain (808→809→810→811) moving PRD
storage into `session-manager-operations/` for consistency with how feedback
(`session-manager-operations/feedback/`) and HUMAN_LEARN already scope per-project operational
state there (see this repo's root CLAUDE.md). Global bookkeeping (`queue.json`, `history.jsonl`,
`runs/`) stays exactly where it is — this PRD only relocates PRD source `.md` files. Ship a
one-time, idempotent migration that moves every existing PRD from the old global dir into its
target project's new location, based on that PRD's own frontmatter `cwd` field.

# Acceptance criteria

- [ ] New module `src/main/lib/prdLocations.cjs` exports a function that resolves the list of
  `<cwd>/session-manager-operations/scheduler/prds/` directories for every active project cwd
  (reuse `activeProjectCwds` from `scripts/lib/activeSessions.cjs:62` — the same discovery
  `scripts/lib/watchdogHelpers.cjs`'s `sweep()` already uses, around lines 617-627), plus a
  single-project resolver that takes one `cwd` string and returns its PRDs dir path.
- [ ] `src/main/scheduler.cjs`: replace usages of the single global `PRDS_DIR` constant
  (defined at line ~289, used in roughly 20 places for job/PRD file lookups — grep `PRDS_DIR`
  in this file first to enumerate every call site) with resolution via `prdLocations.cjs`
  scoped to each job's own `cwd` field, not one fixed directory.
- [ ] `src/main/queueOps.cjs`: same repoint for its `ROOT`/`PRDS_DIR`-derived path usages
  (queue linter, archive, retag logic — `ROOT` is defined around line 43).
- [ ] Migration function, run once at scheduler init: for each `.md` file found in the OLD
  global PRDS_DIR, parse its frontmatter `cwd` (reuse `src/main/lib/prdFrontmatter.cjs`'s
  `splitFrontmatter`), move (rename, not copy) it into
  `<cwd>/session-manager-operations/scheduler/prds/<same filename>`, creating the target
  directory if missing. Idempotent — already-migrated files (no longer present in the old dir)
  are a no-op on subsequent runs. Logs a one-line summary (`moved N, skipped M`).
- [ ] Safety fallback: after migration runs, scheduler init still checks the OLD global
  PRDS_DIR for any leftover files (e.g. unparseable frontmatter, missing `cwd`) and logs a
  warning rather than silently dropping them — no PRD may be stranded or silently lost.
- [ ] After running once locally, this project's own existing PRDs end up under
  `~/Projects/session-manager/session-manager-operations/scheduler/prds/`.
- [ ] `timeout 300 npm run typecheck` passes.
- [ ] New/updated unit tests for `prdLocations.cjs` and the migration function under
  `src/main/__tests__/`, following existing patterns in `src/main/__tests__/prdCreate.test.cjs`
  and `queueOpsAutoArchive.test.cjs`.
- [ ] `timeout 300 npx vitest run src/main/__tests__/queueOpsAutoArchive.test.cjs` passes
  (update fixtures for the new path resolution as needed).

# Implementation notes

`cwd`: `~/Projects/session-manager`. Current single-dir constants: `src/main/scheduler.cjs:288-289`
(`ROOT`/`PRDS_DIR`). Job/PRD path usages are scattered through `scheduler.cjs` (~20 refs
including lines 411, 418-419, 430, 611, 616, 621, 627, 983, 1244, 1393, 1760, 1770, 1946, 2122,
2780, 2900, 3044, 3057-3058, 3133, 3141, 3367, 3369, 3408 as of authoring time — re-grep, this
file changes) — enumerate every call site before editing rather than editing blind.
`queueOps.cjs` has its own `ROOT` at line ~43. `activeProjectCwds` signature:
`scripts/lib/activeSessions.cjs:62` — `activeProjectCwds(maxAgeMin = 90, opts)`. Precedent for
using it from scheduler-adjacent code: `scripts/lib/watchdogHelpers.cjs`'s `sweep()`.
Frontmatter parsing: `src/main/lib/prdFrontmatter.cjs`'s `splitFrontmatter`. This is PRD 1 of a
4-PRD chain (808→809→810→811); PRD 809 depends on `prdLocations.cjs`'s exported function names
and signatures landed here, so keep them simple and stable (e.g. `resolvePrdsDirs()`,
`resolvePrdWriteDir(cwd)`) and note the final names in your commit/PR description.

# Out of scope

- Renderer changes (PRD 810)
- Docs/skill file updates (PRD 811)
- Repointing `rcaFeedbackHook.cjs`, `definitionOfDone.cjs`, `health.cjs` (PRD 809)
- Moving `queue.json`, `history.jsonl`, or `runs/` — those stay in the global
  `~/.claude/session-manager/scheduled-plans/` location; this PRD only moves PRD source `.md`
  files

## Engineering standards

Before writing any code, read
`/home/bilko/Projects/session-manager/plugins/session-manager-dev/skills/develop/standards.md`
— it has the Performance, Debugging, API-reuse, TDD, and Execution-discipline rules that apply
to this PRD. Every rule in it is mandatory, especially Execution discipline (bounded commands,
verify before done, the finish-protocol sentinel).

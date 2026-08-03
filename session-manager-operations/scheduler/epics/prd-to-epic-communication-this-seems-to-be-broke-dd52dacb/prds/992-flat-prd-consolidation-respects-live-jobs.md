---
title: consolidateFlatPrds must not archive a PRD that still has a live queue job
cwd: /home/bilko/Projects/session-manager
estimateMinutes: 18
sourcePromptId: prd-to-epic-communication-this-seems-to-be-broke-dd52dacb
---
# Goal

src/main/lib/prdMigration.cjs's consolidateFlatPrds(cwd) moves EVERY .md out of the retired flat scheduler/prds/ dir into prds-archived/ at boot, unconditionally — it never consults queue state. But the scheduler still scans that flat dir as a PRD source (src/main/lib/prdLocations.cjs:133, "scan sources alongside the legacy flat dir"), so a PRD can legitimately be sitting there with a pending or running queue job. If the app restarts at that moment, the source file is archived out from under a live job row, which then cannot resolve its PRD. Make consolidation skip any file whose slug has a live job, so the retired-dir cleanup can never silently strand queued work.

# Acceptance criteria

- [ ] Read src/main/lib/prdMigration.cjs (consolidateFlatPrds at line 100 — note it currently only filters on `.md` suffix and a leading dot, then renames unconditionally, with a `-legacy-N` collision suffix), src/main/lib/prdLocations.cjs (resolvePrdWriteDir, resolvePrdsDirs and its line-133 comment about scanning alongside the legacy flat dir), and src/main/lib/queueStore.cjs (how per-project jobs and their statuses are read).
- [ ] CORE: consolidateFlatPrds skips any flat-dir file whose derived slug matches a job in that project's queue with a live status (pending / queued / running — enumerate the exact live set from queueStore's real status values, do not guess). Only files with no job, or whose job is terminal (completed / failed / cancelled), are archived.
- [ ] CORE: every skipped file is reported back in the return value (extend the existing { moved, failed } shape with a `skipped` array carrying file + reason) and logged by the caller at boot, so a permanently-stuck flat PRD is visible rather than silent.
- [ ] EDGE: a needs_review job counts as LIVE for this purpose — it is awaiting human action and its source must survive. Test this case explicitly; it is the one most likely to be got wrong.
- [ ] EDGE: a flat file whose frontmatter is unparseable, or whose slug cannot be derived, is left in place and reported rather than archived or crashed on.
- [ ] EDGE: consolidation remains idempotent — running it twice in a row produces no additional moves and no duplicate -legacy-N files. Test a repeat invocation.
- [ ] EDGE: an unreadable/absent queue.json (fresh project, or a project with no scheduler state yet) must not make consolidation throw or skip everything; define and test the fallback behavior explicitly.
- [ ] INTERACTION EFFECT: queueStore.cjs writes with raw fs and is subject to the fail-closed single-writer law in src/main/lib/opsOwnership.cjs (namespace scheduler, writer 'scheduler'). This PRD only READS queue state — confirm no new write path is introduced and that reading does not trip the guard.
- [ ] INTERACTION EFFECT: confirm the boot ordering in scheduler.cjs — whether consolidateFlatPrds runs before or after queue state is loaded — actually makes live-job data available at consolidation time. If it does not, fix the ordering as part of this PRD and say so in a code comment; a consolidation that reads an empty queue would skip nothing and silently reintroduce the bug.
- [ ] TESTS: unit coverage for skip-on-live-job (pending, running, needs_review), archive-on-terminal-job, archive-on-no-job, the unparseable-frontmatter case, the missing-queue.json case, and idempotence.
- [ ] `npm run typecheck`, `npm run test:unit`, and `npm run health` all pass.

# Implementation notes

Live evidence, observed 2026-08-02: session-manager-operations/scheduler/prds/980-fix-chat-typed-event-renderers.md sits in the retired flat dir with queue status `running`. A restart during that window would have archived its source mid-run. session-manager-operations/scheduler/prds-archived/979-fix-transcript-paged-reads.md is the same shape from an earlier cycle.

consolidateFlatPrds today, quoted so you do not have to grep:
  const flatDir = resolvePrdWriteDir(cwd);
  const archiveDir = path.join(path.dirname(flatDir), 'prds-archived');
  for (const name of entries) {
    if (!name.endsWith('.md') || name.startsWith('.')) continue;
    ... await fsp.rename(src, dst); moved++;
  }

Note the existing sibling function migratePrds() in the same file already models the right instinct — it leaves files it cannot safely relocate in place and returns them as `unresolved` rather than dropping them, and its header comment calls that out explicitly ("never silently dropped"). Follow that same shape for `skipped` rather than inventing a new reporting convention.

Slug derivation must match however the scheduler already derives a job slug from a PRD filename — find that existing helper and reuse it rather than writing a second basename-minus-.md rule (CLAUDE.md's single-source-of-truth / API-reuse rule).

Caller to update for the new return field: scheduler.cjs's boot path, which already logs migratePrds' `unresolved` via its boot safety-net — extend that same logging rather than adding a parallel one.

# Out of scope

- Un-retiring the flat prds/ dir or changing where new PRDs are written — the Epic-scoped path stays canonical
- Recovering PRDs already archived by the current unconditional behavior (none are known to be stranded; do not mass-move files)
- Changing migratePrds' legacy-global-dir migration
- Auto-retry of no-op runs (separate PRD in this Epic)

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).

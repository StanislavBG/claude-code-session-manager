---
title: Epic PRDs/Runs tabs must include archived (completed) PRDs, not just live-queued ones
cwd: /home/bilko/Projects/session-manager
estimateMinutes: 20
sourcePromptId: psess-msase2q4-1
---
# Goal

An Epic's "PRDs" tab count (and list) currently only reflects PRDs whose source `.md` file is still sitting in the live `<cwd>/session-manager-operations/scheduler/epics/<epicId>/prds/` directory. The moment a PRD's scheduler job completes, its file is moved to the sibling `prds-archived/` directory (see `src/main/scheduler.cjs` around lines 354, 600-620), which the `schedule:list-prds` IPC handler (`scheduler.cjs:3925`, via `candidatePrdsDirs()`) never reads. Result: an Epic that has successfully completed 9 PRDs shows "PRDs 0" the instant the last one finishes, because every completed PRD's file disappeared from the only place the count looks. Fix this so the PRDs/Runs tabs show an Epic's REAL historical PRD count, not just its currently-pending one.

# Acceptance criteria

- [ ] `schedule:list-prds` (`src/main/scheduler.cjs:3925`) is extended (or a new sibling IPC method is added, if mixing live+archived shapes into one call would break an existing caller — check every current caller of `window.api.schedule.listPrds()` first) to also read each Epic's `prds-archived/` directory (sibling of its `prds/` dir, same `parsePrd`/frontmatter parsing already used for live files) so archived PRDs are included in the returned list, each still carrying its `sourcePromptId`/`epicId` for the existing per-Epic filter in `epicPrds()` (`src/renderer/lib/epicDerive.ts:104`) to keep working unmodified if possible
- [ ] Distinguish archived-but-successfully-completed PRDs from an archived PRD whose job actually failed/errored (a PRD can be archived on failure too — check `scheduler.cjs`'s actual archive-on-terminal-state logic before assuming archived==success) so the Epic's PRD list/count doesn't silently misrepresent a failed run as a completed one
- [ ] Verify against THIS session's own Epic (`psess-msase2q4-1` in this repo, `session-manager-operations/prompt-sessions/active-index.json`) as a live test case: it has 9 real completed PRDs (917 through 925, now all archived) and should show "PRDs 9" (or the real final count after this PRD's own execution adds a 10th) instead of "PRDs 0" once this fix lands
- [ ] `epicPrds()`'s return shape (`EpicPrd[]`, `lib/epicDerive.ts:87-95`) keeps working for its existing consumer(s) in `EpicDetail.tsx` — read how the PRDs tab currently renders `attachedPrds` (`EpicDetail.tsx:380`) before changing the shape, and update rendering if a new field (e.g. `archived: boolean`) is added so archived PRDs are visually distinguishable from a still-queued one rather than looking identical
- [ ] `timeout 300 npm run typecheck` passes
- [ ] A test covering `schedule:list-prds` (or wherever the archived-read logic lands) confirms archived PRDs for a given epicId are returned alongside live ones — check `src/main/__tests__/` for an existing test file covering `schedule:list-prds` or `candidatePrdsDirs` to extend rather than starting a new one

# Implementation notes

Read `candidatePrdsDirs()` (`scheduler.cjs:485-487`), `resolvePrdsDirs()` (wherever it's defined — grep for it), and the archive-on-completion code around lines 600-620 and 1100-1150 first, to understand exactly which directory a given Epic's archived PRDs land in (confirm it really is a sibling `prds-archived/` next to that Epic's own `prds/`, not the flat legacy `PRDS_ARCHIVE_DIR` at line 354, for Epic-scoped PRDs specifically — the comment at scheduler.cjs:519-521 suggests both exist and the distinction matters). Don't conflate this with `schedule:get-history` (`scheduler.cjs:3965`, reads `queue.json`'s job history) — that's job-run history, a different data source from PRD source-file archival; this PRD is about the PRD list, not the job list, though the two should agree.

# Out of scope

- Changing where PRDs get archived to in the first place
- The Runs tab's own data source (job history) unless it turns out to share the same root cause — investigate but don't scope-creep into unrelated Runs-tab work if it's actually fine
- Any UI polish beyond making archived PRDs visible/countable and distinguishable from pending ones

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).

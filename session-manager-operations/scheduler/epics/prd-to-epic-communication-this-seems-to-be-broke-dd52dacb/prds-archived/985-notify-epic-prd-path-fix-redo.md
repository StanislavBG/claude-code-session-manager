---
title: Re-do PRD 972: route completed/failed PRD check-ins back to the authoring Epic (first attempt shipped no code)
cwd: /home/bilko/Projects/session-manager
estimateMinutes: 45
sourcePromptId: prd-to-epic-communication-this-seems-to-be-broke-dd52dacb
---
# Goal

This is a RE-QUEUE of PRD 972, which was recorded completed on 2026-08-03 but shipped zero code — the bug it describes is still fully live in main. `notifyOriginatingTab` (`src/main/scheduler.cjs:1840`) resolves a finished PRD via `prdPathForJob(job)` → `resolvePrdWriteDir(cwd)` → the RETIRED flat `<cwd>/session-manager-operations/scheduler/prds/` directory, which today contains only zero-byte `.reserved-NNN` stubs and no `.md` files at all. Every real PRD lives under `scheduler/epics/<epicId>/prds/`, and by notify time `archiveCompletedPrd` (called at scheduler.cjs:3052-3054, immediately before the notify at :3057) has already renamed it into `prds-archived/`. So `parsePrdRaw` ENOENTs, `prd` is null, `sourcePromptId` is null, and both the durable transcript append and the `appendResponseEventIfKnown` response-event append are skipped — a completed PRD never reports back to the Epic that authored it. Verified live: PRDs 961/962/963/964/967 all completed between 02:22 and 03:16 on 2026-08-03 and not one response event landed on either authoring Epic's chain.

# Acceptance criteria

- [ ] `notifyOriginatingTab` resolves the PRD file by trying, in order: the live Epic-scoped dir via the existing `findPrdDir(job.slug)` helper (scheduler.cjs:604), then the existing `archivedPrdPathForJob(job)` helper (scheduler.cjs:537). No new path-resolution helper is written; `prdPathForJob` is no longer used for this lookup.
- [ ] `notifyOriginatingTab` falls back to `job.epicId` when the PRD frontmatter is unreadable or carries no `sourcePromptId` — matching `notifyNeedsReview`'s existing `prd?.sourcePromptId || job.epicId || null` at scheduler.cjs:1923 — for BOTH the `epicIdForTranscript` transcript append (currently :1849) and the `appendResponseEvent` call (currently :1863).
- [ ] `notifyNeedsReview` uses the same live-then-archived PRD lookup rather than bare `prdPathForJob(job)`.
- [ ] New unit test in `src/main/__tests__/scheduler-notify-originating-tab.test.cjs`: a completed job whose PRD .md exists ONLY under `<tmp>/session-manager-operations/scheduler/epics/<epicId>/prds-archived/<slug>.md` still results in `appendResponseEvent` being called with that PRD's `sourcePromptId`. NOTE: the existing tests in this file all inject a stubbed `parsePrdRaw`, which is precisely why this bug shipped green — this new test must exercise REAL path resolution against a temp dir, and must fail against current main.
- [ ] New unit test: a completed job whose PRD .md is missing entirely but whose queue row carries `epicId` still results in `appendResponseEvent` being called with `job.epicId`, and `appendTranscriptTurn` called with the same id.
- [ ] MANDATORY EVIDENCE OF WORK — the completion report must quote the actual `git diff --stat` for this run showing a non-empty change to `src/main/scheduler.cjs` plus at least one test file. A report claiming success with an empty diff is a FAILED run, not a completed one. If you conclude no change is needed, do not print PASS — stop and say so explicitly.
- [ ] `npm run typecheck`, `npm run lint:selectors`, and `npm run test:unit` all pass.

# Implementation notes

Main-process only. Read the appended standards file first.

WHY THIS IS A RE-QUEUE — read before starting. The previous attempt (run dir `~/.claude/session-manager/scheduled-plans/runs/2026-08-03T03-44-58-361Z/`) exited 0 after 34 seconds and 5 turns having edited nothing. Its final result text was a recap of the authoring Epic's conversation about OTHER PRDs rather than an implementation report. Your deliverable is the code change described above — not a status summary, not a plan, not a report on other PRDs. If you find yourself about to summarise the Epic's discussion, you have misread the task.

Confirm the bug is still present before starting (it was as of commit ea89b99): `grep -n "prdPathForJob" src/main/scheduler.cjs` should still show the call inside `notifyOriginatingTab` around line 1840, and line ~1849 should still read `const epicIdForTranscript = prd?.sourcePromptId || prd?.sourceTabId || null;` with no `job.epicId`. If those are already fixed, stop and report that rather than inventing work.

Key files/lines:
- `src/main/scheduler.cjs:1831-1895` — `notifyOriginatingTab`. The `prdPathForJob(job)` call at :1840 is the defect.
- `src/main/scheduler.cjs:1913-1931` — `notifyNeedsReview`, the correct reference for the epicId fallback (:1923); its own `prdPathForJob` at :1922 has the same path defect.
- `src/main/scheduler.cjs:604` `findPrdDir(slug)` (async, scans `candidatePrdsDirs()`) and `:537` `archivedPrdPathForJob(job)` (scans `listArchivedPrdDirs`) — the two existing helpers to compose. Reuse them; do not reinvent.
- `src/main/promptSessionEvents.cjs:55` `appendResponseEventIfKnown` — the sink. It already requires an active session and a non-empty event chain; both hold in the failing cases. PRD 976 has since added an optional 4th metadata arg (`prdSlug`/`outcome`) — preserve that call signature.
- `src/main/scheduler.cjs:3052-3061` — the archive-then-notify ordering. Do NOT reorder these; make the lookup archive-aware instead.

Do not change the doc comment's described resolution ORDER (Epic response-event first, then external-send fallback) — only fix which file it reads and add the epicId fallback.

# Out of scope

- Reordering archiveCompletedPrd relative to notifyOriginatingTab
- Changing appendResponseEventIfKnown's active-session or non-empty-chain guards
- Any renderer-side change
- Backfilling response events for the already-missed PRDs 961-964/967
- The verdict/commit-guard fix (PRD 983) or the context-digest fix (PRD 984)

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).

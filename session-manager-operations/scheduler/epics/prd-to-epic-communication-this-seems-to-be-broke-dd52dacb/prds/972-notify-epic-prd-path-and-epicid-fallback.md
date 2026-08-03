---
title: Fix PRD→Epic completion notification: resolve PRD from Epic-scoped + archived dirs, fall back to job.epicId
cwd: /home/bilko/Projects/session-manager
estimateMinutes: 40
sourcePromptId: prd-to-epic-communication-this-seems-to-be-broke-dd52dacb
---
# Goal

`notifyOriginatingTab` in `src/main/scheduler.cjs` never routes a completed PRD's result back to its authoring Epic, because it resolves the PRD file via `prdPathForJob(job)` → `resolvePrdWriteDir(cwd)` → the RETIRED flat `<cwd>/session-manager-operations/scheduler/prds/<slug>.md`. Every modern PRD lives in `scheduler/epics/<epicId>/prds/`, and by the time notify fires the file has additionally been `fsp.rename`d into `prds-archived/` by `archiveCompletedPrd` (called at scheduler.cjs:3052-3054, immediately BEFORE the notify at :3057). So `parsePrdRaw` ENOENTs, `prd` is null, `sourcePromptId` is null, and both the durable transcript append and the `appendResponseEventIfKnown` response-event append are skipped — the code silently falls through to a cwd-matched open tab and fires an unrelated `chat:external-send`. Fix the PRD path resolution and add the missing `job.epicId` fallback that `notifyNeedsReview` already has (which is why needs_review routing works and completed/failed routing does not).

# Acceptance criteria

- [ ] `notifyOriginatingTab` resolves the PRD file by trying, in order: the live Epic-scoped dir via the existing `findPrdDir(job.slug)` helper (scheduler.cjs:604), then the existing `archivedPrdPathForJob(job)` helper (scheduler.cjs:537) — no new path-resolution helper is written; `prdPathForJob` is no longer used for this lookup.
- [ ] `notifyOriginatingTab` falls back to `job.epicId` when the PRD frontmatter is unreadable or carries no `sourcePromptId` — matching `notifyNeedsReview`'s existing `prd?.sourcePromptId || job.epicId || null` line (scheduler.cjs:1920) — for BOTH the `epicIdForTranscript` transcript append and the `appendResponseEvent` call.
- [ ] `notifyNeedsReview` uses the same live-then-archived PRD lookup as above rather than bare `prdPathForJob(job)`.
- [ ] New unit test in `src/main/__tests__/scheduler-notify-originating-tab.test.cjs`: a completed job whose PRD .md exists ONLY under `<tmp>/session-manager-operations/scheduler/epics/<epicId>/prds-archived/<slug>.md` (i.e. already archived, absent from the flat dir) still results in `appendResponseEvent` being called with that PRD's `sourcePromptId`. This test must FAIL against current main — the existing tests all inject a stubbed `parsePrdRaw`, which is exactly why this bug shipped green.
- [ ] New unit test: a completed job whose PRD .md is missing entirely but whose queue row carries `epicId` still results in `appendResponseEvent` being called with `job.epicId`, and `appendTranscriptTurn` being called with the same id.
- [ ] `npm run typecheck`, `npm run lint:selectors`, and `npm run test:unit` all pass.

# Implementation notes

Read `session-manager-operations/scheduler/PRD_AUTHORING.md`-adjacent standards file appended to this PRD before starting.

Evidence of the failure (already reproduced, do not re-litigate root cause):
- `session-manager-operations/scheduler/prds/` contains ONLY `.reserved-NNN` zero-byte number-reservation stubs — zero `.md` files. `prdPathForJob` points there.
- History rows 961/962/963/964 (Epic `psess-msckxplj-24`) and 967 (Epic `psess-msch6x36-16`) all completed between 02:22 and 03:16 on 2026-08-03; the last event on either Epic's chain in `active-index.json` predates every one of those completions. Zero `response` events landed.
- 20 of 21 history rows carry `epicId`, so the fallback has real data to use.

Key files/lines:
- `src/main/scheduler.cjs:1831-1895` — `notifyOriginatingTab`. The `prdPathForJob(job)` call at :1840 is the defect; `epicIdForTranscript` at :1849 and the `prd?.sourcePromptId` guard at :1863 both need the `job.epicId` fallback.
- `src/main/scheduler.cjs:1913-1931` — `notifyNeedsReview`, the correct reference implementation for the epicId fallback (:1920); its own `prdPathForJob` at :1919 has the same path defect.
- `src/main/scheduler.cjs:604` `findPrdDir(slug)` (async, scans `candidatePrdsDirs()`) and `:537` `archivedPrdPathForJob(job)` (scans `listArchivedPrdDirs`) are the two existing helpers to compose — reuse, do not reinvent.
- `src/main/promptSessionEvents.cjs:55` `appendResponseEventIfKnown` — the sink. It already requires `session.status === 'active'` and a non-empty event chain; both hold in the failing cases, so no change is needed there.
- `src/main/scheduler.cjs:3052-3061` — the archive-then-notify ordering. Do NOT reorder these (archiving before notify is intentional and other logic depends on it); make the lookup archive-aware instead, per the AC.
- Both notify functions take injectable deps for testing; keep that shape and inject the new lookup if it makes the tests cleaner.

Do not change the doc comment's described resolution ORDER (Epic response-event first, then external-send fallback) — only fix which file it reads and add the epicId fallback.

# Out of scope

- Reordering archiveCompletedPrd relative to notifyOriginatingTab
- Changing appendResponseEventIfKnown's active-session / non-empty-chain guards
- Any renderer-side change to EpicDetail.tsx or the promptSession:event-appended handling
- Backfilling response events for the already-missed PRDs 961-964/967

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).

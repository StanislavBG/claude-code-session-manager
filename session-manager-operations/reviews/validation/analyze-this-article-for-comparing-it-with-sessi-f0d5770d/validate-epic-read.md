# Validation: epic-read plan (3318–3322)

Base: 1421acb0871e7f492b49adaf914fd454ff85f7a2. Gates re-run in the foreground: one vitest run over all nine gate test files (9 files, 355 tests, pass), `npm run lint:readme` (exit 0), `npm run typecheck` (exit 0). /code-review and /security-review not run; self-reviewed the diff instead.

## epic-outside-state — VERIFIED
- `src/main/lib/epic/epicOutsideState.cjs:1-190`: exports EPIC_OUTSIDE_STATES (8 states) and computeEpicOutsideState; pure (no fs/Date.now), non-object inputs guarded.
- Jobs filtered by epicId/sourcePromptId === session.id; investigating counted as running (the status switch).
- Verdicts keyed by bare slug over the whole chain, newest wins, reason after the first ' — ', 300-char cut. `validate-` jobs skipped; a job whose finishedAt is later than its verdict is unvalidated.
- State order matches the PRD: closed, awaiting_approval, needs_input (and not chatBusy), blocked (refuted, failed, needs_review, quarantined; cancelled rows excluded), working, verified, in_review, open. `blocked` is null otherwise.
- `epicSettle.cjs:121` exports isCancelledRow, which the new module imports.
- Extra check requested: status `active` never blocks `verified` (only `completed` and `proposed` are checked, so an active Epic with all PRDs verified returns `verified`). A refuted PRD that is later verified goes only into `verified`, because the newest verdict wins, so it no longer blocks.
- Gate green.

## chat-awaiting-input-reader — VERIFIED
- `src/main/exchanges.cjs:160,170,185,198-200`: formatAskedResult, resultAwaitsInput, awaitingInputSessions, all exported. The reader uses readTailRecords, which is bounded by MAX_TAIL_BYTES (:77). A later non-marker row deletes the session id.
- `src/main/chatRunner.cjs:43,942`: calls formatAskedResult at the needs-input site.
- Tests in `src/main/__tests__/exchanges.test.cjs` pass. Gate green.

## epic-outside-record — VERIFIED
- `src/main/lib/epic/epicOutsideRead.cjs`: exports listOpenEpicRecords and getEpicRecord. buildRecord has every required field, and goalText is split at the first blank line.
- Open Epic: readActiveIndex plus injected listJobs (array or {jobs}), claudeSessionId in awaiting, isTabBusy. Archive: readArchived, only when archivedAt is set, status forced to completed.
- externalRef is resolved through findEpicByExternalRef. Unregistered project gives null and everything is in try/catch.
- list: open Epics only, newest createdAt first, state filter, limit default 50 / max 200, one listJobs and one awaitingInputSessions call per list.
- Gate green.

## epic-read-routes — VERIFIED
- `src/main/lib/epic/epicAdminRoutes.cjs`: GET /admin/epics and /admin/epic with 200, 404 'not found' and 400 'invalid query' with details. Non-absolute cwd or a missing ops folder gives 400 with the reason.
- `src/main/ipcSchemas.cjs:612-633,1644-1645`: both schemas defined and exported. limit coerced 1..200 (default 50), offset >=0 (default 0), exactly-one-of id/externalRef refine, normalizeExternalRef used.
- `src/main/index.cjs:116`: registered with isTabBusy and listJobs. Gate green.

## epic-read-mcp-tools — VERIFIED
- `scripts/scheduler-mcp-server.cjs:400-425,981-1007`: epic_list (partial-page note) and epic_get (error result before any admin call when both or neither of id/externalRef); descriptions from descriptionFor.
- `src/main/lib/mcpToolCatalog.cjs:623-640`: two entries in group `epics`, which the enum at :26 includes. README mentions both tools; lint:readme passes. Catalog test expects 32 (`mcpToolCatalog.test.cjs:260-261`). Gate green.

## Findings
- Critical: none.
- Important: none.
- Minor:
  - `epicOutsideRead.cjs:~180-215`: getEpicRecord has an opt-in `receipt` option (landed in commit c5cbc342) that no PRD in this plan listed. It is opt-in and read-only, so harmless.
  - `scripts/scheduler-mcp-server.cjs:414-425`: epic_get enforces the either-or rule in the handler only, and the schema's `required` is just `cwd`; the PRD suggested `requiredOneOf` if the file supports it. The behavior holds.

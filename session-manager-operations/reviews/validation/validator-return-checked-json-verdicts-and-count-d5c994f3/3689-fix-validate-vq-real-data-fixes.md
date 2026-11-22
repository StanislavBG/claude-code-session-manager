# Validation: vq real-data fix wave (PRDs 3686-3688)

Re-validated from the tree at HEAD (afefab80). The original run's record was lost: it was written to
gitignored `plan-records/`, which the running v0.139.0 scheduler does not harvest. No product code was changed.
Commits fac75527, cdb61235 and 1d8c9d05 are all ancestors of HEAD.

## vq-legacy-verdicts-unclassified (PRD 3686, fac75527) — VERIFIED

- `refutedReason` is exported: `src/main/lib/epic/epicOutsideState.cjs:233`. Its behavior is unchanged.
- Reason is `ev.reason` when non-empty, else `refutedReason(ev.text)`, else null: `src/main/lib/scheduler/validationQuality.cjs:119`.
- Legacy means `!Array.isArray(ev.missKinds)` (`validationQuality.cjs:121`). Legacy REFUTED events skip `missKinds`/`topMiss`
  and go to `week.unclassified { count, prds, reasons (max 5) }` (`validationQuality.cjs:~235-246, 269-274`).
  `missKinds: []` still counts as `other` (`validationQuality.cjs:~247`).
- Tests cover all cases with real-shaped events: only-legacy gives `topMiss` null; one gate-red plus five legacy gives
  `topMiss` gate-red count 1; `missKinds: []` gives `other`; `ev.reason` beats text.
- Gate: `validationQuality.test.cjs`, `validationQualityHandlers.test.cjs` and the epicOutsideState test pass (3 files, 47 tests).
- Note: the PRD names `src/main/lib/scheduler/validationQuality.cjs`; the task brief's `src/main/lib/validationQuality.cjs` does not exist.

## vq-panel-unclassified-line (PRD 3687, cdb61235) — VERIFIED

- `src/preload/api.d.ts:3569`: `unclassified: { count: number; prds: string[]; reasons: string[] }`.
- `ValidationQuality.tsx:170-200`: when `u.count > 0` it renders `val-q-unclassified` with "Not classified (recorded before checked verdicts): N",
  the PRD slugs, and at most 5 reasons. `weekRows` (line 111) includes projects with `unclassified.count > 0`, so
  "No validator misses this week." (line 166) is not shown for them.
- Gate: `ValidationQuality.test.tsx` passes (8 tests; covers unclassified only, unclassified plus top miss, and neither).
  `npm run typecheck` and `npm run lint` are green.

## verdicts-file-safe-epic-id (PRD 3688, 1d8c9d05) — VERIFIED

- `src/main/scheduler.cjs:4015-4019`: when `isSafeEpicId(epicId)` is false, no `.verdicts.json` is written and one `console.error` names `job.slug`.
  The `else if` keeps the write for safe ids. Verdict events are appended on both paths (the test checks this).
- `validatorStructuredVerdict.test.cjs:163`: an epicId of `../scheduler` writes no file under the temp root and still appends the events. The 12 tests pass.
- Gate: `npm run typecheck` is green.

## Real-data check (read-only)

`gatherValidationQuality({ cwd: <this project>, loadQueueJobs/loadProjectHistory/loadRecentHistory stubbed to [] })` read this
project's real epic events. No scheduler state was touched, and nothing was written. Last 7 days:

- `week.topMiss` = null, every `missKinds` count = 0.
- `week.unclassified.count` = 7 (seven PRD slugs). Reasons are text reasons taken from legacy events (for example
  "scan still lists ambiguousRefs ...", "nothing landed in restorableSessions files ...").

So `topMiss` is not `'other'` with an empty reasons list, `unclassified.count` is > 0, and the reasons are text.

## Findings

### Critical
None.

### Important
None.

### Minor
- `ValidationQuality.tsx` reads `week.unclassified` as always present (`p.week.unclassified.count`, lines 111 and 170). It would throw on a
  payload from an older main process without that field. Carried over; the field is always emitted now.
- Process: the original record was lost to `plan-records/` being ignored. Fixed on main by `harvestPlanRecords` (646228e1); it waits for a release.

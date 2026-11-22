# Validation: needs-you-only-questions

Base: 9d4bc97d650896392edf90f5041a107e6f4fa5c4. All five PRD files found in prds-archived/. Combined gate re-run: 40 test files / 643 tests pass (needsHuman, epicDerive, epics components, homeNeedsYou, schedulerStages, SchedulerTopBands(+slots), scheduleJobTransitions); `npm run typecheck` exit 0; `npm run lint:docs` ok.

## needs-human-definition — VERIFIED
- src/renderer/lib/needsHuman.ts:11 `epicHasOpenQuestion` (needs-input only); :27 `parkedJobLine` with the exact sentence + cause mapping (:20-24); header (:3-6) states the rule in two sentences. Test file passes.

## needs-you-epic-chip — VERIFIED
- epic-primitives.tsx:29 label 'being fixed', comment :25-27. epicDerive.ts:6 imports helpers, :84 `epicHasOpenQuestion`, :136 `parkedJobLine(needsReviewJob)`. epicDerive.test.ts:147-156 (never 'needs'), :242-247 (new tooltip). Gate green.
- `grep -rn "is asking a question" src/renderer` → only homeNeedsYou.ts:147 and its test :36, label 'Session is asking a question' for a genuine needs-input chat (a real question). Not a park wording; see Minor.

## needs-you-lists-questions-only — VERIFIED
- homeNeedsYou.ts:199-201 skips needs_review (only `failed` gets a row). schedulerStages.ts:538 counts needsReviewCount, :543-545 `needsYou = failedCount + quarantined`; stage only from failed/quarantined (:550). SchedulerTopBands.tsx:434-439 `kpi-being-fixed` 'Being fixed' / 'the scheduler is handling them'. Tests pass.

## park-errors-no-manual-review — VERIFIED
- scheduler.cjs:10624-10628 frozen PARK_ERRORS with the three '— parked' strings; used at :10921/:10924/:10927; console.log :10932 says 'parked'. `grep -n "manual review" src/main/scheduler.cjs` → none; no 'manual review' under src/main/__tests__. Test asserts at scheduleJobTransitions.test.cjs:286-288. verifierVerdict keys unchanged (PARK_ERRORS keyed by them).

## law-needs-you-is-a-question — VERIFIED
- CLAUDE.md:119 exact line (<200 chars); `wc -c CLAUDE.md` = 11196 (<12000). scheduler-operations.md:205 sentence with helper link. lint:docs ok.

## Findings
### Critical
- none
### Important
- none
### Minor
- src/renderer/lib/homeNeedsYou.ts:147 (+ test :36): 'Session is asking a question' still matches the literal "is asking a question" grep in the 3590 criterion. It labels a real needs-input chat, so it is correct behavior; the criterion's grep was just broader than intended.
- Review commands (/code-review, /security-review) not run as separate tools; self-reviewed the diff: no unsafe input, secrets, path handling, or duplicated helpers (needsHuman.ts is pure and now the single check used by epicDerive).

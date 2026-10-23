# Validation: bounded post-run re-fires

Base: 6348683e2418ffefea47d25f4796eb65b87b3133 (known). Commits: 8ba0b43c (2121), 329ff0eb (2122), 6e83da0f (2123).
Gates re-run (foreground): vitest on the union of all three PRDs' gate files — 11 files / 124 tests passed; `npm run typecheck` exit 0.
Absence check: `grep -rn "parsePrdBodyDepFragments\|extractSoakFromBody\|soakFloorDate" src scripts tests` → clean.
/code-review and /security-review not run as separate agents; self-reviewed the diff (no new I/O, paths, secrets or input parsing).

## 2121 verify-deps-dependson-only — VERIFIED
- No definition/export of the two helpers: grep clean; `runVerify.cjs:221` `function checkDeps(queueEntry, allJobs)`.
- Call site `runVerify.cjs:711` `checkDeps(queueEntry, allJobs)`; no `soakFloorDate` anywhere.
- Prose-dep and unmet-dependsOn (`(need completed)`) tests: in `depGateAgreement.test.cjs` (+21 lines), pass in gate run.
- `runVerify.test.cjs` prose/soak tests deleted (diff -686 lines), not skipped.

## 2122 refire-cap-primitive — VERIFIED
- `refireCap.cjs:16,40` exports `MAX_CONSECUTIVE_VERIFY_REFIRES = 2` and `decideVerifyDowngrade`.
- Count coercion `:25`, `nextCount` `:26`, refire/park return `:28-36`; reason string matches spec exactly (`:35`); cap clamped `Math.max(0, cap)` `:27`.
- Pure: no I/O, no mutation. Test file `refireCap.test.cjs` (45 lines) passes.

## 2123 refire-cap-wire-finalize — VERIFIED
- `scheduler.cjs:6728` `decideVerifyDowngrade(...)`; refire → `resetJobFields(...)` then `verifyRefireCount = nextCount` (`:6730-6731`). resetJobFields returns false on refusal, so count is set only when reset succeeded.
- Park: `effectiveStatus='needs_review'`, `capParkVerdict`, `error` = helper reason, `verifierVerdict='refire_capped'` stamped before transition via the existing path (`:6757-6783`).
- `resetJobFields` deletes the count (`:2715`); every non-downgrade finalize outcome deletes it (`:6788`), after the refire branch returns — ordering correct (reset clears, refire re-sets).
- Ladder: one shared predicate `isRefireCapped` (`reviewLadder.cjs:41`) consulted in `isEligibleForNeedsReviewAutoResolve`, `isRescanCandidate` (feeds `reverifyNeedsReview` at `scheduler.cjs:9113`), and `selectAutoFixTargets`. `isGuardParkedWithoutAutoFix`/`isStaleSharedTreeRevertedPark` require other verdicts, so cannot match a refire_capped row.
- `scheduler-refire-cap.test.cjs` covers 3-downgrade park, clean-run reset, ladder skip; passes.

## Findings
### Critical
- none
### Important
- none
### Minor
- `scheduler-refire-cap.test.cjs` simulates the finalize branch rather than driving `spawnJob` end to end (the branch is inside a large closure), so a wiring regression in `scheduler.cjs:6728-6735` would not be caught by it.
- `reverifyNeedsReview`'s separate `isGuardParkedWithoutAutoFix` candidate arm (`scheduler.cjs:9113`) is not guarded by `isRefireCapped`; safe today only because the verdict sets are disjoint.

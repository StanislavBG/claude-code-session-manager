# Validation: epic-timeline-status-of-finished-prd

Base: 481afa57 (known). Commit for the PRD: cb990b66 (touches exactly the 4 listed files). Gate is `none` for the validate PRD; I also re-ran the PRD's own vitest gate: 2 files, 98 tests pass.

## epic-timeline-status-of-finished-prd — VERIFIED

- AC1 (outcome map): `src/renderer/lib/epicTimeline.ts` adds `latestOutcomeBySlug` (interface + loop, `bareSlug` key, response events with prdSlug and outcome only, later overwrites) and returns it.
- AC2 (status rule): `EpicDetail.tsx` ~1289-1304: queue row -> `prdStatusFor(prdJob, validation)`; no row + outcome -> outcome for `validate-` bare slug, else `resolveValidatedStatus(outcome, validation)`; neither -> verified/refuted verdict, else `prdStatusFor(null, validation)`.
- AC3 (cases): table test "PRD 3466" covers completed validate, completed+verified, +refuted, +no verdict (claimed), failed, needs_review, failed validate, and the row-present cases. All pass.
- AC4 (3457 special case replaced): the old one-line `!prdJob && verdict` expression is gone from the diff; the 3457 test row "no verdict, queue row gone" was updated to expect `claimed`.
- AC5 (tests): `epicTimeline.test.ts` has the outcome map tests (bare slug, later event wins, ignores events without slug/outcome and prd_created); `EpicDetail.test.tsx` has the cases above.

Not checked: the app was not launched. A visual check by the owner is still due.

## Findings

Critical: none
Important: none
Minor:
- `src/renderer/lib/epicTimeline.ts` (outcome loop): a verdict event (bare slug, `outcome: 'completed'`) overwrites an earlier `failed`/`needs_review` outcome for the same PRD; the pill then reads from the verdict. This is an edge case and arguably right, but it is not stated in the PRD or tested.

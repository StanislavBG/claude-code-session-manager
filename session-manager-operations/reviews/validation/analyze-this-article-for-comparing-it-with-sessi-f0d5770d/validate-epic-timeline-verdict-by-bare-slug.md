# Validation: epic-timeline-verdict-by-bare-slug (PRD 3457)

Base: e41c402dec06971f12be5c53eed9030c99590d93. Landed commit: 74f60c64 (touches exactly the 4 PRD files).

## epic-timeline-verdict-by-bare-slug — VERIFIED

- AC1: `src/renderer/lib/epicTimeline.ts:98` sets the map with `bareSlug(e.prdSlug)`; the loop still overwrites earlier events (Map.set in event order). Import at line 7.
- AC2: `EpicDetail.tsx:1292` looks up `latestValidationBySlug.get(bareSlug(e.prdSlug))`. It is the only other reader of the map (grep).
- AC3: `EpicDetail.test.tsx` it.each "PRD 3457" covers verified, refuted and no-verdict, each with the queue row present and gone. `epicTimeline.test.ts` "keyed by bare slug" covers all three. All pass.
- AC4: both test files contain the new tests (see AC3).
- AC5: the existing tests pass. One deviation: `EpicDetail.tsx:1293` also makes a final verified/refuted verdict the status when the queue row is gone. The PRD did not ask for this, but the notes say the queue row of a finished PRD is gone, so it is needed for the fix to show. See Minor.
- Gate: vitest (2 files, 87 tests) pass; `npm run lint` exit 0; `npm run typecheck` exit 0.
- Review: self-review of the diff. No unsafe input, secrets or paths. `bareSlug` is reused, not duplicated.

**A visual check by the owner is still due** — the row cannot be checked by launching the app; the tests are the only proof.

## Findings

Critical: none
Important: none
Minor:
- `src/renderer/components/epics/EpicDetail.tsx:1293` adds a verdict-when-queue-row-gone rule that is not in the PRD's acceptance criteria (AC5 says nothing else changes). It is justified and tested, but is undocumented scope.

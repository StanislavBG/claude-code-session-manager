# Validation: md-review-output plan (PRDs 3143-3146)

Base `76fe9825` (known); HEAD `989bdb7f`. Commits: 77a107d0 (reader), 18f977b0 (IPC), 023cf273 (Last review), 989bdb7f (run history). `/code-review` and `/security-review` not run as skills; self-reviewed instead (see Findings).

## md-review-record-reader — VERIFIED
- `src/main/lib/mdReviewRecord.cjs` exists; `EPIC_ID_RE` at :27, `MAX_RECORD_BYTES = 256*1024` at :29, bounded `fsp.open` read at :213, ids filtered at :275.
- Registered in `tsconfig.main.json:26` and `scripts/lib-layout.json:89`.
- Gate: `vitest mdReviewRecord.test.cjs` plus typecheck and lint all exit 0. The 5 plan test files pass together (76 tests).

## md-review-ipc — VERIFIED
- `projectPages.cjs:130` handler `mdReview`, registered at :326, exported at :342; `ipcSchemas.cjs:935` schema; `preload/index.cjs:419`; `apiSurface.json:1439-1440`.
- Gate: `projectPagesMdReview.test.cjs` passes; typecheck exit 0; lint exit 0 (includes the apiSurface drift check).

## md-review-last-review-section — VERIFIED
- `MdLastReview.tsx` has the Open record, Open validation record, Review due and Run drift check actions (:153, :164, :175). `ToolsPane.tsx:186` fetches mdReview; the fetch does not poll. `setExplore` is used at :577.
- Gate: `MdLastReview.test.tsx` and `ToolsPane.test.tsx` pass; typecheck exit 0; lint exit 0.

## md-review-run-history — VERIFIED
- `mdReviewRuns.ts:38-49` implements the status ladder (proposed / refuted / validated / completed / PRDs queued n/m / reporting / reported). `ToolsPane.tsx:659` renders the Review runs list; :765 builds the row meta `… · last run <date> · <status>`.
- Gate: `mdReviewRuns.test.ts` and `ToolsPane.test.tsx` pass; typecheck exit 0; lint exit 0.

## Real-path probe — VERIFIED
`readMdReview('/home/bilko/Projects/family-frame', {epicIds:[review-md-network-use-the-session-manager-dev-ma-87716e85]})` returned:
- ok true; recordPath `session-manager-operations/reviews/docs/2026-11-15-md-network.md`
- date 2026-11-15; baseCommit `bab11306fe9757cbdc1d7a40862d63c0bc30829d`; 19 followUpPrds; nextReviewDue 2027-02-15; session null (the record predates the Session line)
- validation: `.../validate-md-map-links.md` and `.../validate-md-network.md`. The requested validate-md-network.md is present; the folder also holds validate-md-map-links.md.

## Full suite
- `npm run lint`: exit 0. `npm run typecheck`: exit 0.
- `timeout 1200 npm run test:unit`: 2 failed / 10380 passed.
  1. `scripts/__tests__/dev-plugin-skillset.test.cjs` "plugin.json version equals the marketplace entry version": plugin.json is 0.4.1 and `.claude-plugin/marketplace.json:17` is 0.4.0. This is **not green at HEAD**. The bump came from sibling plan commit 7b2b4e91 (md-skill-link-convention), outside the four validated PRDs.
  2. `scheduler-resume-recovery-saturated.test.cjs` hook timeout under full-suite load. It passes alone (2/2), so it is load flake.

## Findings
### Critical
- none
### Important
- `.claude-plugin/marketplace.json:17` has version 0.4.0 but `plugins/session-manager-dev/.claude-plugin/plugin.json` is 0.4.1 (bumped by 7b2b4e91). `dev-plugin-skillset` fails, so the full unit suite is red at HEAD. Fix: set marketplace.json to 0.4.1. Belongs to the md-skill-link-convention PRD (3140).
### Minor
- `scheduler-resume-recovery-saturated.test.cjs` times out in `afterEach` under full-suite load (known flake class, see the tick-test settling notes).
- The family-frame record has no Session line, so validation matching relies on the "exactly one review session" fallback in the UI.

None of the four PRDs' own acceptance criteria are refuted. The red suite is a sibling-PRD regression.

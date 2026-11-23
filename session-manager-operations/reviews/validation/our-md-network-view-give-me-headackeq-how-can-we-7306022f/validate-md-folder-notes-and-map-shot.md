# Validation: md-folder-notes-entry-points, md-network-shots-map-card

Base: a11b648c. Commits: b86f53eb (folder notes), 4f661464 (map card spec). PRD files: 3728, 3729 under prds-archived/.

## md-folder-notes-entry-points — VERIFIED
- mdLinks.cjs:334-338 exports `isAgentsStub` (same regex as old `importsAgentsFirst`, plus non-string guard); export at :340.
- drift-check.cjs:27 imports it; :282 and :331 call it; `importsAgentsFirst` no longer defined (grep clean).
- mdNetworkScan.cjs `FOLDER_NOTE_NAMES` (CLAUDE.md, AGENTS.md, CLAUDE.local.md), used in `isLoadedByTools` by basename at any depth.
- Tests: mdNetworkScan.test.cjs and md-links.test.cjs extended; gate vitest (5 files) = 101 passed; `npm run typecheck` exit 0.
- Read-only `scanMdNetwork($SM_PROJECT_ROOT)`: 12 orphans (session-manager-operations/ 10, web/ 2), folder-note orphans ending CLAUDE.md/AGENTS.md/CLAUDE.local.md = 0.

## md-network-shots-map-card — VERIFIED
- Spec lines added in tests/web-ui/md-network-shots.spec.ts: `locator('[data-testid="md-link-map"]')`, `scrollIntoViewIfNeeded()`, `mapCard.screenshot()` to `review-md-network-map-{scheme}.png`; viewport 1280 for the shot, restored to 1440.
- Label assertion: `(renderedWidth / viewBoxWidth) * 10.5 >= 10`, viewBox width asserted 760.
- Gate: playwright md-network-shots + project-home-library-shots = 2 passed.
- Both PNGs opened (950x577 card, light and dark): full card shown, header, legend, Expand, graph, footer hint all present. No clipped or overlapping text, no text visibly below 10px (card 950px wide / 760 → ~13px labels), layout intact.
- Note: running project-home-library-shots rewrote foreign-WIP PNGs under project-home-as-a-player…/screens in this worktree; not staged.

## Findings
- Critical: none.
- Important: none.
- Minor: none. (12 non-folder-note orphans remain in session-manager-operations/ and web/; out of scope for these PRDs, noted in PRD 3728's report.)

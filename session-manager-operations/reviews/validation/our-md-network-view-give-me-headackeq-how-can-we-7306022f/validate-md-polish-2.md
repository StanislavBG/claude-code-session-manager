# validate-md-polish-2

Base: c318e1ea (commits found via `git log c318e1ea..HEAD`: 97f69d19 legend, 630b43d0 stack/labels, f1ca1d36 shots, 2e460ffe page-overview).
PRD files: prds-archived/3719, 3720, 3721, 3722 (all present).

## md-explorer-legend — VERIFIED
- `MdLinkMap.tsx:482` exports `MdMapLegend({ layout })`, filtering `LEGEND` by kinds present (`:485`); the LINK MAP card uses it at `:528`; no second copy of the legend markup.
- `MdNetworkExplorer.tsx:22,317-321`: `md-explorer-legend` at `right-3 top-3` inside the canvas; rendered only in Graph view (test `MdNetworkExplorer.test.tsx:190-204` asserts List view has none).
- Tests: `MdLinkMap.test.tsx` and `MdNetworkExplorer.test.tsx` cover both places.
- Gate: `vitest run projecthome src/renderer/lib` → 139 files / 1570 tests passed; `npm run typecheck` exit 0.

## md-pane-stack-and-labels — VERIFIED
- `MdLinkMap.tsx:~590` `MdNetworkCards` renders `MdFixList` then `MdLinkMap` in a `flex-col` stack, both full width (light/dark PNGs show FIX LIST above LINK MAP, full width).
- `MdFixList.tsx:180,185` path spans carry `[overflow-wrap:anywhere]`.
- `MdFixList.tsx:100-104` `openLabel`; test `MdFixList.test.tsx:177` expects `['Open src/CLAUDE.md', 'Open CLAUDE.md']`; PNG shows "Open src/CLAUDE.md".
- Gate: same vitest + typecheck run as above, green.

## md-network-shots-realistic — VERIFIED
- Spec moves pointer off canvas before the Graph shot; `project-home-entry.tsx` `files.read` returns a markdown body (heading, 2 paragraphs, 3 bullets, relative `.md` link); the PNG preview shows exactly that.
- Spec asserts legend visible and FIX LIST above LINK MAP (diff f1ca1d36).
- Gate: `playwright test … md-network-shots.spec.ts project-home-library-shots.spec.ts` → 2 passed.
- PNGs opened (light pane, dark pane, explorer Graph): no clipped text, no text under 10px (smallest ≈11px legend), no broken layout. Graph shot has no dimmed nodes and the legend is top-right, clear of the zoom toolbar. Not findings by design: sparse fixture, modal overlay, `docs/architecture.md` label crossed by the same-column arc.

## page-overview-links-code-map — VERIFIED
- `.claude/agents/page-overview.md:44` replaced the refresh-rule paragraph with one line linking code-map.md's `lib/useDashboardRefresh.ts` entry; page-specific rule kept.
- `code-map.md` has no diff in `c318e1ea..HEAD`.
- Gate: findDuplicates node check exit 0 (no pair); `check-page-stewards.cjs` clean; `lint:docs` ok.

## Review
Self-reviewed the combined diff for the touched paths (no `/code-review` run on the whole 48-file range, which includes unrelated AGENTS.md migration commits): no unsafe input, secrets or path handling in the changed renderer/test code; legend reuses one component.

## Findings
- Critical: none.
- Important: none.
- Minor: the pane PNGs (1440x1100) crop the LINK MAP card mid-graph because the app scroller, not the page, scrolls, so the full-width map is not visible in the shot (`tests/web-ui/md-network-shots.spec.ts:65`). Not a product defect.

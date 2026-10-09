# Validation: manual-book fix wave

Base: c85fd61 (Bilko `manual-book`, before the fix). Fix commit: 4a8a6db, the only commit in `c85fd61..HEAD`. It touches exactly the 3 files the PRD names. Ports 3002 and 4000 were free before Playwright ran.

## mb-fix-sticky-header-and-flip-fallback — VERIFIED
- AC1 (sticky header): `src/styles/session-manager-manual.css:14-19` has `.smlm-root .smlp-header { position: sticky; top: 0; z-index: 10 }`. The only other z-index in the file is 3 (line 593), so the header sits above the rail and card. The diff does not touch the landing's `.smlp-header`. The manual CSS has no `overflow` rule on ancestors above the header (overflow appears only at lines 142, 198, 411, 613 and 662, all on inner elements), so sticky is not broken.
- AC2 (fallback split): in `session-manager-landing.css` (Book turn block, about lines 2119-2200) all 6 mixed selector lists, 4 in the base block and 2 inside `prefers-reduced-motion`, are now separate `:active-view-transition-type(...)` and `html[data-book-turn=...]` rules with identical declarations. `grep -nE 'active-view-transition-type.*,\s*$' src/styles/*.css` finds no remaining mixed list.
- AC3 (e2e): `e2e/session-manager-manual.spec.ts:103-109` scrolls the window to 1500px, polls `scrollY > 0`, then expects the header's `box.y` to be 0. It passed in the re-run (test 5 of 9).
- AC4 (commit and log): one commit, 3 files. The `MANUAL-BOOK-LOG.md` line `mb-fix-sticky-header-and-flip-fallback 4a8a6db …` is present, and the third gate command (grep) exits 0.
- Gate re-run: `pnpm exec vite build` built in 2.63s with exit 0. `playwright test e2e/session-manager-manual.spec.ts` ran 9 and passed 9. The grep gate passed.

## Prior record's findings
- Important #1 (header not sticky): closed, see AC1 and AC3.
- Important #2 (fallback rules dropped in browsers without the pseudo-class): closed, see AC2. This was checked by reading the CSS only. No browser lacking `:active-view-transition-type()` was run.

## Findings
### Critical
- none
### Important
- none
### Minor
1. The prior record's Minor items remain open, as the PRD placed them out of scope: stale `href` on the third dot, no right padding on the header link, and `bookTurn.ts` touched outside its PRD.
2. The fallback rules are now duplicated verbatim, 6 pairs. That is the cost of the split and is acceptable. A shared custom class would not help, because the selector is what differs.
3. A read-only self-review of the diff found no unsafe input handling, secrets or path traversal (CSS and a test only). `/code-review` and `/security-review` were not run as separate tools, so this is a manual review.

# Validation — landing two pages (cover + Parts Bin vertical flip)

Base: 049d286d74e07ff61190d6e2cc650282d17e30eb (known). Bilko worktree `/home/bilko/Projects/Bilko-two-pages`, branch `landing-two-pages` (4 commits over origin/main). Reviewed with self-review (correctness, input handling, secrets, path traversal, helper duplication); no secrets, no path handling, no network input in the diff.

**Branch not published:** `git status -sb` → `## landing-two-pages...origin/main [ahead 4]`; no `origin/landing-two-pages` ref; `merge-base --is-ancestor landing-two-pages origin/main` → not merged. Clean tree. OK.

## tp-spec-two-pages — VERIFIED
- Commit 5861e2f6 (DESIGN_SPEC.md, copy.json).
- copy.json `pages` = next/prev/aria.{nav,cover,parts,goToTemplate} with the exact strings (node JSON.parse OK); key order `…tabs, pages, film, endCard`.
- DESIGN_SPEC.md:799 section `## 2026-10-08 — two pages with a vertical page flip` with Pages, Canvas geometry, Flip, Inputs, Hash, Accessibility, Reflow, Pure helpers, Tests subsections (lines 805–884).
- DESIGN_SPEC.md:226 pointer under Canvas layout; :449 State bullet pointer to Hash subsection.
- Gate (JSON.parse of copy.json) → exit 0.

## tp-pager-helpers — VERIFIED
- Worktree exists on landing-two-pages; commit f5c13fc touches exactly copy.ts, layout.ts, tests/session-manager-landing.test.ts.
- layout.ts exports PAGE_COUNT, pageForKey, createWheelTurner, swipeDirection, pageFromHash, hashForPage with spec behaviour (threshold 80, ×16/×860, 450ms quiet re-arm, |dy|≥60 and >|dx|, `#parts`).
- copy.ts `pages` mirrors copy.json. Tests: 37 in session-manager-landing.test.ts.
- TWO-PAGES-LOG.md has the `## Bilko branch landing-two-pages` list with the SHA.
- Gate: `pnpm typecheck` exit 0; vitest 3 files / 74 tests passed.

## tp-two-page-structure — VERIFIED
- cb1b3a7 touches only SessionManagerPage.tsx + session-manager-landing.css.
- SessionManagerPage.tsx: `.smlp-pages` stack with cover section (Hero, PriceTag, stripes) and `#parts` section (back button + PartsBin); header outside; page state from `pageFromHash(location.hash)`; replaceState keeps pathname+search; hashchange listener; `inert` via ref effect; aria-hidden; aria-labels from COPY.pages.aria; dots `<nav>` with goToTemplate labels and aria-current; focus-to-heading with preventScroll.
- Reflow: controls gated on `canvas`; inert only when `canvas`; `id="parts"` always. e2e 390x844 test passes.
- Gate: typecheck, vitest, `vite build` ("built in 2.72s") all exit 0. CSS numeric values not re-measured line by line; covered by the e2e geometry and the screenshots.

## tp-flip-and-inputs — VERIFIED
- b2c7833 touches only SessionManagerPage.tsx + CSS.
- `turning` ref gate, 900ms fallback timer (FLIP_FALLBACK_MS), cleared on cover transitionend (target-checked); hash path uses `smlp-pages--instant` (no animation).
- Single effect keyed on `[canvas, filmOpen, turnTo]`: non-passive wheel on root with preventDefault + one createWheelTurner; keydown skips ctrl/meta/alt, film open, `input, textarea, select, [contenteditable], [role="tablist"]`, Space on button/a; touchstart/touchend via swipeDirection; all removed in cleanup; returns early when not canvas. Hooks all above any return per gate typecheck.
- Gate green (same three commands). e2e confirms ArrowDown in tablist does not turn.

## tp-e2e-and-screens — VERIFIED
- c9a6c79 touches e2e spec (+123) and CSS (6-line fix, disclosed in the PRD's allowance).
- Ports 3002/4000 free before and after. `playwright test e2e/session-manager-landing.spec.ts` → **29 passed**.
- Screenshots exist (valid PNGs): cover-1440x860 (1440x860), parts-1440x860, midflip-1440x860, cover-1920x1080, reflow-390x844 (390x1868 full page). Viewed cover: hero, price tag, stripes, turn button, dots, no Parts Bin. Viewed parts: back row, Parts Bin panel filling the page, 40px title/ghost 01, aside.
- TWO-PAGES-LOG.md lists all four Bilko SHAs; this repo commit fa9f31f8.

## Findings

### Critical
- none

### Important
- none

### Minor
- `SessionManagerPage.tsx` wheel handler: `preventDefault()` runs for every wheel event in canvas mode (when the film is closed), so wheel never scrolls inside the Parts Bin content if it ever overflows in a short viewport. Matches the spec; revisit if the bin gets taller content.
- `SessionManagerPage.tsx` `onTransitionEnd` accepts `opacity` as well as `transform`; fine for the reduced-motion crossfade, and the 900ms fallback bounds any miss.
- Reflow screenshot was not viewed pixel-by-pixel; the e2e covers overflow and presence.

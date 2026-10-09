# Validation: Field Manual as landing-book page 3

Base: 6b6a18cb. Bilko branch `manual-book` (5 commits ahead of origin/main). PRD files found in `prds-archived/` (1630–1635).
Bilko push check: `git status -sb` → `manual-book...origin/main [ahead 5]`; `git branch -r --contains manual-book` → empty. Not pushed or merged. OK.
Gate re-runs (all green): typecheck exit 0; vitest 6 files / 108 tests pass; `vite build` ok; Playwright landing+manual specs 37/37 pass (ports 3002/4000 were free before the run, so the port-hazard rule did not trigger).

## mb-spec-manual-book — VERIFIED
- copy.json: `book` sits right after `pages`, with exactly the six required strings (python json load).
- DESIGN_SPEC.md:894 holds the new section with every required subsection (Chrome … Tests). :805 holds the pointer line "Page 3 is the Field Manual — see the section below." All eight Bilko files are named.

## mb-book-turn — VERIFIED
- bookTurn.ts exports turnBook / markBookPageReady / waitForBookPageReady / shouldInterceptClick / bookNavigate with the specified semantics (read, :27-111). Object form first, function form + `data-book-turn` fallback, cleanup in `finally`.
- CSS "Book turn (cross-route)" block at the end of session-manager-landing.css: perspective 2400px, rotateX 0 → -100deg, brightness 1 → .65, 700ms cubic-bezier(.2,.7,.2,1), reduced-motion 150ms fade. Rules are gated by transition type or `html[data-book-turn]`, so nothing leaks into ordinary navigation.
- tests/session-manager-book.test.ts: 9 tests pass. Commit ee23724 touches exactly the 3 files. Log line present.

## mb-landing-turn-to-manual — VERIFIED
- copy.ts mirrors copy.json `book`. `.smlp-turn--manual` button centred at bottom 18px. `.smlp-bin` bottom margin is 64px (CSS).
- SessionManagerPage.tsx: wheel, swipe and PageDown/ArrowDown/Space on the last page call `turnToManual`; the `turning` ref blocks re-entry; End is unchanged. PartsBin `onTabChange` feeds `activeTab` (a ref). Chapter card link, header link and the third dot are intercepted via `shouldInterceptClick` + `bookNavigate`. `markBookPageReady` is called in a mount effect.
- Deviation: commit b17a1ba also touched bookTurn.ts (2 lines), which the PRD's file list does not allow. Minor.

## mb-manual-chrome — VERIFIED
- Header.tsx has the specified props. With current='manual' the link is `COPY.book.backToApp` → `/products/session-manager`; `onLinkClick` is supported.
- App.tsx: the manual route moved outside Layout (:200-209); the `/products/*` splat entry was removed.
- ManualPage.tsx: every branch goes through `root()` → `smlp-root smlm-root` + Header; imports landing CSS; `usePageFonts()`. All hooks sit above the early returns (read, :80-220; `root` is a plain function).
- Landing tests and the open-core test pass.

## mb-manual-book-page — VERIFIED (with spec deviation, see Important #1)
- Layout vs spec, from the CSS and manual-1440.png: spread max-width 1360, padding 0 40px 40px, columns 300px/1fr (rail x 82–378, card from x 412, i.e. 30px gap); card padding 48px 56px (text at x 468 = 412+56); 2px ink border, 4px 4px 0 shadow, rust tape, ghost "05" top-right, "CHAPTER 5 OF 13"; title 52px; rail rows are 48px apart; back row and 3 dots present, dot 3 filled. manual-390.png: single column, `<select>` picker, no dots, no shadow, card padding 24px 20px, no horizontal overflow.
- ManualPage: no Tailwind utilities and no `.manual-prose`; the rules were removed from index.css. `openChapter` uses `turnBook` with the direction taken from chapter index. Focus moves to the heading and the card scrolls into view. `<main aria-label>`, `<nav aria-label="Chapters">` with aria-current, and the chapter-of text are all present.
- Prose coverage: against the real 2.0.1 chapters, every tag and class used has a `.smlm-prose` rule except `aside`, `thead`, `tr`, `tbody`, `dl` (the bare element needs no style, since the `.manual-*` classes and th/td/dt/dd carry them) and the `toc` class (standalone edition only). Fine.

## mb-e2e-and-screens — VERIFIED
- The new manual spec covers every case in the spec's Tests list (37 passed in total, including the landing spec's 3-dot expectation). All four PNGs exist (landing-page2-1440, manual-1440, manual-mid-turn-1440, manual-390). The log notes a real bug fix (manual reflow header overflow at 390px).

## Findings
### Critical
- none
### Important
1. The manual header is not sticky. The spec's Chrome section says `position: sticky; top: 0`, but `.smlp-header` is `position: relative` (session-manager-landing.css:147) and nothing in session-manager-manual.css overrides it. The rail's `top: 70px` and the card's `scroll-margin-top: 72px` (session-manager-manual.css:666-669, whose comment says "under the sticky header") assume a sticky header. The header scrolls away, so the rail sticks 70px from the top with a gap.
2. The view-transition fallback rules are dropped in browsers that lack `:active-view-transition-type()`. Each rule is a selector list pairing it with `html[data-book-turn=…]` (session-manager-landing.css, "Book turn" block). An unsupported pseudo-class invalidates the whole list. The `data-book-turn` fallback then never applies, and those browsers get the default crossfade, not the flip. They are exactly the browsers where the object form of `startViewTransition` throws. Navigation still works. Split the two selectors into separate rules.
### Minor
1. SessionManagerPage.tsx (third dot): the `href` uses `activeTab.current`, a ref. Changing tab does not re-render the page, so the href is stale for ctrl/middle-click. The intercepted click recomputes it correctly.
2. In the screenshots the header's right-hand link sits flush against the viewport edge (manual-1440.png and manual-390.png) with no right padding.
3. b17a1ba touched bookTurn.ts, outside its PRD's file list.
4. Dots 1 and 2 on the manual carry the `smlp-dot--manual` class, which only matters for the landing's third dot.
No hooks below early returns, no router `<Link>` use (plain `<a>` with intercepted clicks), no view-transition CSS outside book turns (apart from #2). Security self-review: chapter HTML is first-party via `dangerouslySetInnerHTML` (as before); hrefs are constants or TOC slugs; no secrets and no path handling.

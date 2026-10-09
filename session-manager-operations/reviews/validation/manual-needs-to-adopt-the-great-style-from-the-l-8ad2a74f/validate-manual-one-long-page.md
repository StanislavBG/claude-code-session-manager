# Validation: manual is one long page

Base: 4a8a6db (Bilko) → 3188782 (`feat(session-manager): field manual is one long page`, 3 files: ManualPage.tsx, session-manager-manual.css, manual e2e spec). Session-manager side: 2febb9ff (log line), 8cd09546 (DESIGN_SPEC).
Bilko checkout: /home/bilko/Projects/Bilko-manual-book (manual-book, in step with origin/main at 3188782).
Port hazard: `ss -ltnp` showed nothing on 3002/4000 before and after Playwright.

## mb-manual-one-long-page — VERIFIED

Gate re-run (all exit 0): `pnpm typecheck` clean; vitest 5 files / 90 tests passed; `vite build` built; Playwright landing + manual specs **40 passed**; `grep mb-manual-one-long-page MANUAL-BOOK-LOG.md` hit (`mb-manual-one-long-page 3188782 …`).

- Fetches every TOC chapter, parallel, per-chapter catch, NO_TOKEN for free chapters: ManualPage.tsx:137-155 (`Promise.all`, `signedIn && !c.free ? currentToken : NO_TOKEN`, cancelled flag).
- Sections in TOC order, `<section id={slug} className="smlm-chapter">`, CHAPTER n OF count, aria-hidden ghost, `.smlm-prose`, part heading per group: ManualPage.tsx:250-300. Failed chapter → title + "couldn't be loaded" notice in place (body === null branch); locked → title/blurb/notice; neither blocks others (state per slug).
- Rail/select/prev-next/openChapter/handleArticleClick/hashchange removed: grep over src for `smlm-rail|smlm-select|smlm-turn-` → none; `openChapter|turnBook|handleArticleClick|hashchange` absent from ManualPage.tsx. Remaining `.manual-next` CSS (css:519-528) styles the chapter-body "next" footer inside prose, not removed chrome (see Minor).
- Single centred column: `.smlm-card` max-width 960px (css:181), spread single column.
- Contents nav `<nav aria-label="Contents" className="smlm-toc">`, plain `<a href="#slug">`, grouped by part, mono 2-digit number: ManualPage.tsx:218-232; reflow `columns: 1` (css:595); `scroll-margin-top: 72px` (css:249).
- Deep link: effect at ManualPage.tsx:157-169 waits for `allSettled`, `scrollIntoView({block:'start', behavior:'instant'})`, `markBookPageReady()` once (`scrolled` ref; also called when toc missing). Back row, dots, header link use `bookNavigate(... 'back')` via `leaveTo`.
- Hooks: every hook (useAuth, useRef, useCallback, useState, useEffect ×4) is declared before the first early return (`if (loading)` ManualPage.tsx:182).
- e2e: spec has "every chapter renders in order … no rail, no turn buttons", "contents link scrolls … URL path unchanged", "/manual#slug deep link shows that section at the top"; all pass.
- Screenshots: `manual-long-1440.png` (title block, two-column contents with part labels, back row, card with tape, chapter 1 + ghost "01"; header pinned, no rail) and `manual-long-390.png` (single column, contents one column, no overflow) inspected; both committed under screens/manual-book/.

## mb-spec-one-long-page — VERIFIED

Gate: `grep -q 'the manual is one long page' DESIGN_SPEC.md` → exit 0 (line 1021 `## 2026-10-08 (later) — the manual is one long page`, after the 2026-10-08 Field Manual section).
- Section content covers 3 pages, `<section id=slug>` in 960px card, two-column contents list, no prev/next/flips, deep-link ready signal, back turns kept (read at DESIGN_SPEC.md:1021+).
- "Superseded by the one-long-page section below." pointers at DESIGN_SPEC.md:915, 953, 1002, 1011 (Manual page layout, Leaving the manual, Accessibility, Tests).

## Findings

Critical: none.

Important: none.

Minor:
- ManualPage.tsx:165 — deep-link scroll fires once all chapters settle; chapter images/fonts loading afterwards can shift layout and move the target slightly (not covered by e2e; stubs have no images).
- session-manager-manual.css:519-528 — `.manual-next` rules style a chapter-body footer; if chapter HTML's "next" links point at non-`#slug` hrefs they would now navigate away rather than scroll (the old in-body click handler was deleted). Content-side check not performed (out of scope).
- Validation could not exercise a real failed-chapter render in a browser; verified by code reading only (per-slug state, null branch renders in place).
- Review tools: `/code-review` and `/security-review` not run separately; self-reviewed the diff: chapter HTML via dangerouslySetInnerHTML is first-party release content (commented), hash is only compared to TOC slugs before `getElementById` (no injection/path traversal), no secrets.

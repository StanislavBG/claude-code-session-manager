# Session Manager landing v2: design spec (bilko.run/products/session-manager)

**Source:** Claude Design project `5c47b8a0-a53c-4c3c-8887-12ceaa7696cb`, file
`Session Manager Landing v2.dc.html`. Copies are saved next to this file:
`landing-v2.dc.html` (v2), `landing-v1.dc.html` (v1, history only), `render-v2-1440x860.png`
and `thumbnail.png`. **`copy.json` next to this file holds every visible string and aria
label.** Implementers render from it and never retype copy from the mock. The mock's `TABS`
array and inline strings are superseded wherever `copy.json` differs. Every difference is
listed under [Changed lines](#changed-lines). The saved copies differ from the design source in
one value only: the mock's `account` default (a personal email address) is replaced with
`you@example.com`, and both PNGs were re-captured with it.

The mock is a `dc-runtime` page: inline hex styles, `style-hover`/`style-active`
pseudo-classes that the runtime turns into `!important` rules (support.js:1542-1588), and a
simulated film player. **Port the layout and tokens, not the runtime.** The real page is a
React component in the Bilko repo. Hover and active states become ordinary CSS rules in the
page stylesheet. Static rotations live in CSS classes, so no `!important` is needed. Inline
`style` attributes are reserved for the few runtime values: canvas scale and offsets, seek
fill and knob position.

## Owner decisions (2026-09-25, final)

1. **The Field Manual is completely free.** All 13 chapters and the PDF and offline downloads
   are free, and there is no buy UI anywhere. The Stripe server wiring stays:
   `PRICE_CATALOG`'s `session_manager` entry, the `STRIPE_PRICE_SESSION_MANAGER` env var, and
   checkout-success resolution, so in-flight or late payments still resolve instead of hitting
   the `contentgrade_pro` fallback (Bilko `server/routes/stripe.ts:364-384`). Existing buyers
   keep their `stripe_one_time_purchases` rows.
2. **The app is free and stays free.** The page shows no struck-through price and no "free
   while we're in alpha". The **ALPHA** header badge stays, as a maturity label only; no copy
   ties it to price.
3. **Copy:** keep the design's layout, voice and every true line. Replace every false or
   partial claim with a true line of the same length. Chapter cards use real **Field Manual
   2.0.x** chapters and deep links, not the design's invented chapter names.

### Ship gate (follows from decision 1)

This page claims the manual is free in five places: the header link, the manual CTA fallback,
the aside FREE chip, "Read this chapter free →" and the end-card CTA. **It ships only
together with, or after, the free-manual release**:

- Field Manual **2.0.1**, all 13 chapters `free: true`, is in progress in the same Bilko
  worktree at `data/manual/releases/2.0.1/`.
- `/api/manual/download/:assetId` becomes public.
- `/api/manual/toc` returns `{ free: true, toc }`.
- The reader and `my-manual` lose their buy UI.
- 2.0.1's `welcome.html` already says "this manual is free too" instead of 2.0.0's "only this
  manual is a paid product".

The 2.0.1 chapter text is otherwise identical to 2.0.0 for every chapter this page links to.
The runtime [truth guard](#truth-guard-runtime) is a second line of defence, not a substitute
for the gate.

## Where it lives (mapping onto real code, Bilko repo)

Route and chunk are unchanged. `/products/session-manager` stays a `lazyRoute` outside
`<Layout/>` (`src/App.tsx:199`), and the loader is `src/config/tools.ts:202`
(`import('../pages/SessionManagerPage.js')`). **The page stays a default export at
`src/pages/SessionManagerPage.tsx`.**

| Concern | File | Notes |
| --- | --- | --- |
| Page shell | `src/pages/SessionManagerPage.tsx` (rewrite) | Default export. Owns tab index, film open state, copy state, TOC state and layout mode. Sets `document.title` from `COPY.meta.documentTitle` and restores it on unmount, as today. |
| Copy | `src/pages/session-manager-landing/copy.ts` (new) | A typed `export const COPY = {…} as const` with **exactly** the content of `copy.json` (minus `$comment`). Bilko rule: new files are TypeScript. |
| Components | `SessionManagerPage.tsx` + `src/pages/session-manager-landing/*.tsx` (new) | In the page file: `Header`, `Hero` (incl. the two CTA cards), `PriceTag`. In the folder: `AccountChip.tsx` (`AccountChip`, `PageViewTracker`, each inside a `QuietBoundary`), `PartsBin.tsx` (`PartsBin`, `ChapterCard`), `FilmDialog.tsx` (controls and end card inline), `CopyButton.tsx`. |
| Hooks | `src/pages/session-manager-landing/hooks.ts` + `layout.ts` (new) | `useLayoutMode()` ([canvas rule](#layout-mode-the-desktop-canvas-rule)), `useBodyOverflowLock(active)`, `useCopyInstall()`, `useManualToc()`, `usePageFonts()`. The pure `layoutMode(vw, vh)`, `formatTime(s)`, `partNumber(i)` and `nextTabIndex()` in `layout.ts` are exported for unit tests. |
| Styles | `src/styles/session-manager-landing.css` (new) | Imported by `SessionManagerPage.tsx`. Every class is prefixed `.smlp-` and every token `--smlp-`; every selector sits under `.smlp-root` or `.smlp-film`. See [CSP](#csp). |
| TOC client | `src/lib/manualClient.ts` → `fetchManualToc()` (existing, line 43) | Returns `{ toc }` or `null`. Reuse it; don't add a second fetcher. |
| Film assets | `public/apps/session-manager/promo.mp4`, `promo-poster.jpg` (existing) | `src` = `/apps/session-manager/promo.mp4?v=2` (57.002 s, 1280x720, H.264/AAC, faststart, Range-served). Poster is 1920x1080. Bump `?v=` whenever the MP4 changes (1-day cache). |
| Clerk | `@clerk/clerk-react` (existing) | `SignedIn`, `SignedOut`, `SignInButton`, `useUser`, **only** inside `AccountChip`. Pattern: `src/components/Layout.tsx:90-103`. |

**Removed from the page:** `BuyPanel`, `PRICE_LABEL`, the `startSessionManagerCheckout`
import, the "Already bought it?" / `my-manual` link, the "Free sample chapter" line and the
old `FEATURES` array. The server-side Stripe endpoint and catalog entries stay (decision 1).
The client helper `src/lib/sessionManagerCheckout.ts` and its test become importer-less.
Deleting them is safe, but that belongs to the free-manual change, not this page.

**Clerk isolation (required).** Today `usePageView()` (which calls `useUser`) runs at the top
of the page. If Clerk fails to initialise, `ClerkErrorBoundary` (`src/App.tsx:42-50`) renders
the app without a provider. Every Clerk hook then throws, and `ToolErrorBoundary` replaces the
**whole** landing page with "This tool hit a snag". Fix:

- Move `usePageView()` into a `<PageViewTracker/>` component that renders `null`.
- Wrap it in its own small error boundary (`QuietBoundary` in `AccountChip.tsx`). On error
  it renders `null` and `console.warn`s, and the page view is simply not recorded.
- `AccountChip` wraps its content in a second `QuietBoundary`, which likewise renders `null` on
  error. A Clerk failure then hides only the chip.
- Nothing else on the page may import from `@clerk/clerk-react` or call `usePageView` (which
  reaches Clerk without importing it); `tests/open-core-positioning.test.ts` pins both.

## Design tokens

Define these as custom properties on `.smlp-root, .smlp-film`. The film dialog is portalled to
`<body>`, outside `.smlp-root`, so it needs its own token scope. **Never declare them on
`:root`**: the stylesheet stays loaded after SPA navigation away from the page.

### Colour (use counts from the v2 mock)

| Token | Hex | Used for | Contrast (text) |
| --- | --- | --- | --- |
| `--smlp-ink` | `#1a1612` | text, every border, hard shadows | 15.8:1 on paper |
| `--smlp-paper` | `#f5f0e6` | page, header, aside, light-on-dark text | — |
| `--smlp-card` | `#fbf8f1` | account chip, CTA cards, Parts Bin panel, controls bar, end-card secondary button | ink 17.0:1 |
| `--smlp-rust` | `#a83818` | links, S tile, stripes, "supercharged.", play buttons, copy button, kicker, ✦ | 5.7:1 on paper; paper on rust 5.7:1 |
| `--smlp-mustard` | `#f4b942` | ALPHA, highlighter band, price tag, active tab, `+` badges, tape, "FM", `$` prompt, hover fills | ink on mustard 10.2:1 |
| `--smlp-body` | `#3a342b` | body text; the modal's dot colour | 10.8:1 on paper, 7.0:1 on mustard |
| `--smlp-muted` | `#5d5648` | tagline, card subtitles, tab numbers, "pick a part" | 6.9:1 on card |
| `--smlp-rule` | `#d4ccb8` | dot grid, dashed divider, muted modal text | 9.2:1 on the modal backdrop |
| `--smlp-forest` | `#2e5a3e` | audience pill, "free!" sticker, FREE chip, THE END badge | paper on forest 7.0:1 |
| `--smlp-sand` | `#e3dcc8` | film thumbnail, video frame, seek track | — |
| `--smlp-ghost` | `#ede6d6` | the giant part number (decorative) | — |
| (no token) | `rgba(26,22,18,.92)` | film `::backdrop`, written as literal values because `::backdrop` doesn't reliably inherit custom properties | — |
| `--smlp-scrim` | `rgba(245,240,230,.35)` | big-play overlay | — |

Page background: `var(--smlp-paper)` with `radial-gradient(var(--smlp-rule) 1.3px, transparent
1.5px)` at `22px 22px`. The film backdrop uses the same dots in the body colour (literal `#3a342b`), and the end card
uses the paper dots. The one pair below 4.5:1 is **rust on mustard (3.7:1)**, so rust text or
a rust focus ring must never sit on a mustard surface; use ink there.

### Type

Fonts come from Google Fonts: **Source Serif 4** (roman and italic, opsz 8..60, weights
400/600/700), **Inter Tight** 400/500/600/700 (body, fallback `-apple-system, "Helvetica
Neue", Arial, sans-serif`) and **JetBrains Mono** 400/600/700. Serif fallback: `Charter,
Georgia, serif`. Mono fallback: `ui-monospace, monospace`.

| Element | Spec (canvas px) |
| --- | --- |
| "Claude Code," | serif 700, 64/1, -.01em (= -0.64px, what the mock renders: its h1 carried -.02em at the UA's 32px). Set on the line itself; on the h1 the em would resolve against 16px |
| "supercharged." | serif italic 700, 124/.95, -.02em, rust. Highlighter `box-shadow: inset 0 -.22em 0 var(--smlp-mustard)`, margin `-2px 0 0 -6px`, padding `0 12px 0 4px` |
| Audience pill | mono 700, 12px, .08em, line-height 1.4 |
| Hero paragraph | 17/1.55, `--smlp-body`, margin-top 24 |
| "Kick the tires first →" | serif italic 18/1.3 |
| CTA title / subtitle | 15px 700 / 13px `--smlp-muted` |
| Price tag | "THE APP" mono 700 11px .14em. "$0" serif 700 64/1 -.02em. Line serif italic 17px. Platforms mono 600 11px .1em. Command mono 11px. Copy button 16px 700; the **copied and failed labels render at 15px** (see [copy button](#copy-button)) |
| Header | wordmark 17px 700 -.01em; tagline serif italic 15px; link 14px 600; chip 13px |
| Parts Bin | label mono 700 11px .14em; "pick a part" serif italic 13px; tabs 14px (500, active 700) with mono 11px numbers |
| Tab content | kicker mono 700 12px .12em rust; title serif 700 32/1.12 -.01em, max-width 580; body 16/1.55, max-width 600; bullets 15px; ghost number serif italic 700 220px |
| Chapter card | labels mono 700 10px; chapter title serif 700 20/1.25; points 13/1.4; link 14px 700 |
| Film dialog | title serif italic 700 24px; controls mono 12-13px 600-700; end headline serif 700 52px -.02em; end body 17px |

### Borders, radii, shadows, rotations

- **Borders:** 2px solid ink by default. 1.5px on badges, chip, thumbnails, tabs, `+` badges,
  tape, seek track and control buttons. 3px on the video frame and big play. The aside divider
  is 1.5px dashed `--smlp-rule`. The header has a 2px ink bottom border.
- **Radii:** 4 (badges, FREE chip), 6 (pills, aside, film thumb), 8 (S tile, command box, tabs,
  control buttons), 10 (CTA cards, copy buttons, play control), 12 (controls bar), 14 (price
  tag, video frame), 16 (Parts Bin panel), 999 / 50% (chip, avatar, circles, track, knob).
- **Shadows:** all hard offsets with zero blur.
  - 2px: S tile, active tab, play control, seek knob.
  - 3px: audience pill, "free!", copy buttons, end-card buttons.
  - 4px: CTA cards, aside.
  - 5px: big play.
  - 6px: price tag, Parts Bin panel, CTA hover.
  - Inside the film dialog the shadow colour is **rust**: 3px on NOW SHOWING and ×, 4px on the
    controls bar, 8px on the video frame.
  - The pin has the ring `0 0 0 3px var(--smlp-paper)`.
- **Rotations:**

  | Element | Rotation |
  | --- | --- |
  | S tile | -6° |
  | ALPHA | -3° |
  | Audience pill | -2° |
  | Film card | -1° |
  | Manual card | +1° |
  | "free!" | -12° |
  | Price tag (`transform-origin: 50% 18px`) | +3° |
  | Aside | +1.2° |
  | Tape | -4° |
  | NOW SHOWING | -3° |
  | THE END | -2° |

- **Hover and active states:**
  - CTA cards: hover `rotate(0) translate(-2px,-2px)` with a 6px shadow, transition .15s.
  - Inactive tabs: hover sets the border colour to ink.
  - ×, the end-card secondary button and the speed, sound and fullscreen buttons: hover fills
    mustard.
  - Links: hover turns rust to ink.
  - Copy buttons: active `translate(3px,3px)` with the shadow removed (.08s).
  - Play control: active `translate(2px,2px)` with the shadow removed.

## Layout mode: the desktop canvas rule

`layoutMode(vw, vh)` uses `vw = window.innerWidth` and `vh = window.innerHeight`, which
already reflect browser zoom and are stable whether a scrollbar is showing or not, so the mode
never flaps:

```
s = min(vw / 1440, vh / 860)
mode = (vw >= 1080 && s >= 0.75) ? 'canvas' : 'reflow'
canvas: offX = max(0, (vw - 1440*s) / 2), offY = max(0, (vh - 860*s) / 2)
```

- **Canvas** reproduces the mock exactly. `.smlp-root.smlp-root--canvas` is `position:fixed;
  inset:0; overflow:hidden` with the dot grid. The paper and dots show through the letterbox bars, so
  no `bg-warm-50` shows at the edges. `.smlp-canvas` is `position:absolute; width:1440px;
  height:860px; transform-origin:0 0` with inline `left/top/transform: scale(s)`. No stylesheet
  rule touches `html` or `body`, because the SPA shares `<body>` with every route. Instead
  `useBodyOverflowLock(canvas)` sets `body.style.overflow = 'hidden'` inline **only while the
  page is mounted in canvas mode**, so a stray body scrollbar can't show as a dead gutter. It
  restores the previous inline value on unmount and when the mode changes to reflow; reflow
  never touches `<body>`. There is **no upscale cap**, per the rule (s = 1.256 at 1920x1080).
- **Reflow** everywhere else: phones, tablets, short laptop viewports (1280x640 gives s =
  0.744) and **browser zoom past about 135% on a 1440-wide screen** (innerWidth drops below
  1080). That keeps WCAG 1.4.4 (Resize text) working: zooming in makes the text bigger instead
  of shrinking the canvas.
- Compute it in a `useState` initialiser (client-only SPA) plus a `resize` listener in
  `useLayoutEffect`, so there is no first-paint flash. Measured anchors, which also serve as
  unit-test cases:

  | Viewport | s | Mode |
  | --- | --- | --- |
  | 1440x860 | 1.0 | canvas |
  | 1920x1080 | 1.2558 | canvas |
  | 1280x720 | 0.8372 | canvas |
  | 1080x645 | 0.75 | canvas (boundary) |
  | 1280x640 | 0.744 | reflow |
  | 1066x790 (1440 at 135%) | — | reflow |
  | 844x390 | — | reflow |
  | 390x844 | — | reflow |

### Canvas layout (1440x860, from the mock)

- **Stripes:** two 40px rust bars at `left:1174` and `left:1226` (flanking the tag string at
  x=1220), `top:58` to the bottom, z-index 0 and `aria-hidden`. They are canvas-only; the
  mock's `stripes` prop is always on.
- **Header:** height 58 (including its 2px border), padding `0 40px`, z-index 2, solid paper.
  - Left, gap 12: S tile (32x32, rust, ink border, shadow 2px, -6°, serif 700 18px paper "S",
    `aria-hidden`), wordmark, ALPHA, tagline.
  - Right, gap 20: manual link (ink 600) and the [account chip](#account-chip).
- **Hero row:** height 421, grid `minmax(0,1fr) 360px`, gap 40, padding `26px 40px 0`.
  - Left column: h1 (line 1 flex with the audience pill, gap 22), paragraph, then the CTA row
    (margin-top 28, gap 18, `position:relative`). The CTA row holds "Kick the tires first →",
    two cards at `flex:1` (padding `8px 12px 8px 8px`; film thumbnail 92x54 sand with a 28px
    rust play disc; manual spine 44x54 ink with a 6px rust left border and mustard "FM") and
    the 62px "free!" sticker at `right:-34px; top:-30px` (`aria-hidden`).
  - Right column (centred): pin 12px, string 2x40px, then a tag 352px wide with `margin-top:
    -22px`, padding `34px 20px 18px`, a punched 16px hole at `top:10px` and a measured height of
    325. The pin, string and hole are `aria-hidden`.
- **Parts Bin panel:** `flex:1`, margin `20px 40px 22px`, grid `260px minmax(0,1fr) 300px`, gap
  30, padding `16px 22px 16px 16px`, card background, 16px radius, 6px shadow.
  - Tab column: label row, then 9 tabs of 28px with gap 3. That fills exactly 303 of 303px, so
    **no tenth tab and no longer labels**.
  - Middle column: padding-top 6, gap 12, the ghost number at `right:-10px; top:-40px`.
  - Aside: margin `8px 0 4px`, padding `24px 18px 14px`, gap 10, tape 92x22 at `top:-13px`,
    and the link pinned with `margin-top:auto`.

**Fit check of the final copy** (the mock re-rendered with `copy.json` in Playwright at
1440x860, fonts loaded):

- Every tab fits.
- Worst-case middle-column slack is 44px (Scheduler and History, whose titles take 2 lines).
  That matches the mock's own worst case.
- Neither the aside nor the tab column overflows on any tab.
- The hero paragraph stays at 2 lines.
- The price tag is 325px without the struck price.
- The manual subtitle fits both `13 chapters of tips & tricks` and the fallback.

If a copy edit breaks any of these numbers, fix the copy, not the canvas.

### Reflow layout (scrollable, same tokens)

Single column, 16px side gutter (plus `env(safe-area-inset-*)`), content max-width 720px and
centred. The dot-grid background runs the full width. Normal document scroll, never a
horizontal page scroll. From top to bottom:

1. **Header** (height 52, sticky is optional):
   - The border and paper run full width, but the content lines up with the column below, as
     the design lines the header up with the page content: each side's padding is
     `.smlp-main`'s centring margin plus its gutter,
     `calc(max(0px, (100% - 752px) / 2) + max(16px, env(safe-area-inset-*)))`. A full-bleed
     16px padding left the brand and the manual link 136-264px outside the column at
     1024-1280px.
   - S tile (28px), wordmark and ALPHA.
   - The tagline is hidden below 760px (with the manual link and the chip it needs ~745px),
     so the wordmark is never the thing truncated. Where it does show, it is the element that
     shrinks first (`flex-shrink: 100`, ellipsis).
   - The header manual link is hidden below 560px, because the hero's manual card carries the
     same link one screen down.
   - The account chip is **collapsed to its avatar**. The email becomes visually-hidden text,
     so screen readers still hear "Signed in as …". Signed out, it shows the "Sign in" pill.
2. **Hero:**
   - The audience pill sits **above** the headline, left-aligned with margin-bottom 12 (the
     upload-2 arrangement).
   - "Claude Code," uses `clamp(36px, 10vw, 64px)`. "supercharged." uses `clamp(48px, 15vw,
     124px)`. Measured in Source Serif 4 italic 700 with the highlighter padding and the -6px
     margin, it occupies 337px at 390 (in a 358px column), 315px at 360 (328px) and 287px at
     320 (288px). **Do not raise the 48px floor.**
   - The paragraph is 16px/1.55.
3. **"Kick the tires first →"**, then the **CTA cards stacked** full width (gap 14), keeping
   their -1° and +1° tilts and hover. From 560px up the manual card adds `margin-top:16px`: the
   tilts eat W·sin1° of the gap at the left end (12.6px on the 720px column) and the film
   card's 4px shadow lands on top, so at 14px the cards would touch. The "free!" sticker moves
   to the manual card's top-right corner (`right:8px; top:-22px`, 52px) so it never pokes past
   the gutter.
4. **Price tag**, full width (max-width 420, centred):
   - Pin and string kept.
   - Tilt reduced to **+1.5°** (same origin).
   - **No stripes.**
   - Padding `30px 16px 16px`, "$0" at 56px.
   - The command never ends in an ellipsis. At ≤380px the tag padding is `30px 12px 16px`, the
     command box `10px 8px` with gap 6, and the copied/failed labels 14px (so the idle button
     stays 50px); at ≤359px the command is 10px; at ≤340px the box padding is 6px, the copy
     button's `13px 10px` and those labels 13px. That keeps the command on one line down to
     320px; past that, reflow lets it wrap (`white-space:normal`, `overflow-wrap:anywhere`)
     rather than hide its end.
5. **Parts Bin**, a card with padding 14:
   - Label row.
   - A **numbered tab row**. Tabs are 40px tall, and the active tab gets mustard + ink border
     + 2px shadow with `translateY(-2px)` instead of `translateX(6px)`.
   - **Below 600px it scrolls horizontally**: `display:flex; gap:6px; overflow-x:auto;
     scroll-snap-type:x proximity; scroll-padding-inline:2px 28px`, a thin scrollbar and a
     28px right-edge fade mask. A 22px `::after` spacer (28 with the gap) lets the last tab
     scroll clear of the fade. Tabs have `scroll-snap-align:center`. Selecting a tab focuses
     it with `preventScroll` and calls `scrollIntoView({block:'nearest', inline:'center'})`,
     which matches the snap alignment: `inline:'nearest'` left the tab flush with an edge
     (under the fade), and a start-aligned snap pulled it back out of view.
   - **The fade alone is not a scroll cue.** Wherever a tab boundary lands at the fade's start,
     the next tab sits wholly inside it and the row reads as complete (measured at about 450,
     568-570 and 680px, and at every width from 752px up, where the row is 688px and tab 07
     starts inside the fade). Overlay scrollbars (macOS, iOS, Android) show nothing until you
     scroll. So the tablist sits in a `.smlp-bin__rail` that carries `data-more` while any
     tab lies past the right edge (scroll listener plus a ResizeObserver on the row and every
     tab, since web fonts widen the tabs), and the rail's `::after` draws an ink `›` over the
     fade, on the tab row. It goes when the row is scrolled to its end.
   - **From 600px the row wraps** (`flex-wrap:wrap`; no scroller, snap, fade, spacer or
     chevron): the column has room for all nine tabs on two or three rows, so none is ever
     off screen.
   - The tab content below the tab row. The ghost number is 120px at the top-right, and the
     title uses `clamp(24px, 6.4vw, 32px)`.
   - The **manual card stacked under the content** (full width, +0.8°, margin-top 24 for the
     tape).
6. **Film dialog:** full viewport. See [Film player](#film-player).

Touch targets are at least 40px for tabs and at least 44px for the film controls and ×.

## Components

### Header

The manual link goes to `/products/session-manager/manual` as a plain `<a href>`. That matches
the current page and passes `tests/session-manager-urls.test.ts` ("no stale top-level manual
links"), which forbids `href="/manual"` in the page and every landing file and pins every
`*href`/`*Href`/`*HrefTemplate` value in `COPY` under `/products/session-manager/`. Its text is `header.manualLink`, or `header.manualLinkNotFree` under the
truth guard. The header is a `<header>` landmark. The S tile and ALPHA are presentational;
ALPHA reads as the text "ALPHA".

### Account chip

- **Signed in (`<SignedIn>`):** the design's pill. `useUser()` provides
  `email = user.primaryEmailAddress?.emailAddress`. The avatar initial is
  `(user.firstName?.[0] ?? email?.[0] ?? header.account.avatarFallbackInitial).toUpperCase()`.
  The email renders at max-width 260px with an ellipsis and `title={email}`, preceded by a
  visually-hidden "Signed in as". The chip is **non-interactive**: the mock has no menu, and
  sign-out lives in the site `Layout`'s `UserButton` on every other page. Wrap it in
  `<div role="group" aria-label="Account">`.
- **Signed out (`<SignedOut>`):** `<SignInButton mode="modal"
  forceRedirectUrl={window.location.pathname}>` wrapping a `<button class="smlp-chip
  smlp-chip--signin">Sign in</button>`, in the same pill style (13px 600, padding `6px 14px`).
  This mirrors `src/components/Layout.tsx:90-103`. Clerk's modal portals to `<body>`, so it is
  never scaled by the canvas.
- **Loading:** render nothing until Clerk is loaded (`<ClerkLoaded>`).
- **Never** render the mock's default `account` prop (a personal email address) or its
  hard-coded "B". No email literal may appear anywhere in page source.
- Everything sits inside a `QuietBoundary`. On error it renders `null`, so the rest of the
  header and page are unaffected.

### Hero and CTA cards

The h1 contains both headline lines, and its accessible name is the headline alone ("Claude
Code, supercharged."). The audience line is read once, before the h1: in reflow it is the
visible `<p>` pill above the h1; in canvas the visible pill is an `aria-hidden` `<span>`
inside the h1's first line (as in the mock) and a visually-hidden `<p>` before the h1 carries
the same text.

- **"Watch it run"** is a `<button>` with `aria-haspopup="dialog"` that opens the film dialog.
  It is not a `#film` anchor. Its text content (title and subtitle) is its accessible name, and
  the thumbnail and play disc are `aria-hidden`.
- **"Read the Field Manual"** is `<a href="/products/session-manager/manual">`. Its subtitle is
  `ctas.manual.subtitleTemplate` with `{n}` = `toc.chapters.length` from `useManualToc()`, or
  `subtitleFallback` while loading or on failure. **Never hard-code a count.** It shows 13 in
  2.0.1. Render the fallback during loading too. Both strings fit on one line (171px and 149px
  at 1440), so the swap doesn't move anything.

### Price tag

A `<section aria-label="Price and install">` in reading order: "THE APP", "$0", "free, and
stays free.", then platforms. The platforms line is visible as "MAC · LINUX" with
`aria-label` "Runs on macOS and Linux" on a `<p>`.

The command box is ink with a mustard `$` (`aria-hidden`). It is a `<code>` with
`user-select:all`, `aria-label` "Install command" and `white-space:nowrap`. The measured
overflow at 1440 is 0.

Below the command box come the copy button and the note "Node 22.12+, Claude Code signed in?
Paste & go." (`COPY.priceTag.note`; see the copy-change table for why 22.12).

#### Copy button

`useCopyInstall()` is one instance per page, so the price tag and the end card share state, as
in the mock.

1. Call `navigator.clipboard.writeText(COPY.meta.installCommand)`.
2. **Only after it resolves**, switch to `copied` for 2200ms.
3. If the API is missing or the promise rejects, select the command text (a `Range` over the
   `<code>`) and try `document.execCommand('copy')`.
   - If that returns `true`, switch to `copied`.
   - Otherwise switch to `failed` for 4000ms. The command stays selected so the visitor can
     press Cmd/Ctrl-C.
4. Labels come from `priceTag.copyLabel`, `copiedLabel` and `copyFailedLabel`. The end card
   uses its own `copyFailedLabel` ("…select it below"). In the failed state the end card
   reveals the same ink command box under its buttons and selects that.
5. Announce each state change once through a single page-level visually-hidden
   `<p role="status">`, using `priceTag.aria.copiedStatus` or `copyFailedStatus`.

**No layout jump:** the mock's copied label wraps to 2 lines at 16px and grows the tag by 20px
(325 → 345). The copied and failed labels therefore render at **15px**. Measured in Inter Tight
700, "Copied — now paste it in your terminal" is 265px against 272px available, and "Couldn't
copy — select it above" is 217px, so the button stays at 50px. The button keeps `min-height:
50px` and may wrap only if the web font failed to load.

The labels share one grid cell (the hidden ones `visibility:hidden`) so the price tag never
jumps. The end card's action row wraps and centres, so a width change is harmless there: its
button hides the inactive labels with `display:none` and is as wide as its current label
(234px idle at 1440, as designed).

### Parts Bin (tabs)

- **Heading:** "THE PARTS BIN" is an `<h2>` styled as the label. "pick a part" is a `<p>`.
- **Tablist:** `<div role="tablist" aria-label="The parts bin">`, with
  `aria-orientation="vertical"` in canvas and `"horizontal"` in reflow.
- **Tabs:** 9 `<button role="tab">`, `id="smlp-tab-{key}"`, `aria-controls="smlp-panel"`,
  `aria-selected`, and a roving `tabIndex` (0 on the selected tab, -1 elsewhere). Each shows
  the mono number `01`…`09` (`aria-hidden`) and the label.
- **Keyboard:** ArrowDown/ArrowRight select and focus the next tab, and ArrowUp/ArrowLeft the
  previous one. Both axes work in both modes, and both wrap around. Home and End go to the
  first and last tab. Activation is automatic, and so is the mock's click behaviour.
- **Panel:** `<div role="tabpanel" id="smlp-panel" aria-labelledby="smlp-tab-{key}"
  tabIndex={0}>` contains:
  - the kicker `partsBin.kickerTemplate` (`PART 02 · SCHEDULER`, label uppercased);
  - the title as `<h3>`;
  - the body as `<p>`;
  - bullets as a `<ul>`. Each `<li>` carries the `+` badge (`aria-hidden`).
  - The ghost number is `aria-hidden`.
- **State:** the index starts at 0. There is no URL or hash sync in v1.

### Chapter card (aside)

An `<aside aria-label="From the Field Manual">` containing:

- the tape (`aria-hidden`);
- the label row "FROM THE FIELD MANUAL", plus the "FREE" chip when the chapter is free;
- the chapter title, a `<p>` in serif 20px 700;
- the dashed rule;
- the points as a `<ul>` with ✦ markers (`aria-hidden`);
- the link.

Details:

- **Title:** `toc` chapter title when `useManualToc()` has it for that slug, otherwise
  `tab.chapter.title` from copy. They are identical today, and a test keeps them so.
- **Link:** `<a href="/products/session-manager/manual#{slug}">` with visible text
  `partsBin.aside.link` and `aria-label` from `chapterLinkTemplate` ("Read this chapter free:
  {title}"). The label contains the visible text, which satisfies WCAG 2.5.3.
- **Deep links:** `ManualPage.tsx:35-39` reads the hash. An unknown slug silently opens chapter
  1 (`:75`). So if the TOC loaded and lacks the slug, link to the bare manual URL and
  `console.warn`. The tests below make that case unreachable in practice.
- **Shared chapters:** four tabs share `cockpit-tour` and two share `agents-and-missions`.
  Chapters have no section anchors, so those tabs deep-link to the chapter top, and their
  points differ per tab.

### Film player

**Structure:** a native `<dialog class="smlp-film">` portalled to `document.body` and opened
with `showModal()`.

- It sits in the top layer, and `::backdrop` covers the **whole viewport**, including the
  canvas letterbox bars that the mock's backdrop left uncovered.
- The dialog fills the viewport (`width:100vw; height:100dvh; max-*:none; margin:0; border:0;
  background:transparent`). A click whose `target === dialog` is a backdrop click and closes
  it.
- `aria-labelledby` points at the title.

**Canvas mode:** the panel is the mock's 1040px stack: header row, 1040x585 frame, 60px
controls bar, gap 14, at the mock's left 200 / top 52 (V2:137), scaled by the same `s`. The
scaled canvas is always centred in the viewport, so the panel's top edge is at `50% - 378·s`:
`filmPanelCanvasStyle(s)` sets `top: calc(50% - 378·s px)` and `transform: translateX(-50%)
scale(s)`, and the stylesheet puts `transform-origin` at the panel's top centre. That matches
the design at every canvas size. (Centring the 713px stack vertically put it 21.5 canvas px
low.)

**Reflow:** full viewport with padding 16 (plus safe-area insets) and no scaling.

- The header row keeps NOW SHOWING, the title and ×. "57 SEC" is hidden below 640px, and "ESC"
  is hidden in reflow.
- The frame is `width:100%; aspect-ratio:16/9; max-height:calc(100dvh - header - controls -
  padding)`.
- The controls wrap below 640px. Row 1 holds play, time, seek and duration. Row 2 holds speed,
  sound and fullscreen, right-aligned.
- **Short viewports (height ≤ 500px, landscape phones):** the height-capped stage is narrow
  enough that the controls wrap onto two rows, so everything around the frame tightens: dialog
  padding 8px top and bottom, panel and stage gaps 10, controls `padding:6px 12px; row-gap:6px`,
  options gap 10 with `6px 8px` buttons (so row 2 fits the 280px minimum stage). The stage
  reserves `16 + 44 + 20 + 110 = 190px`: `width:min(100%, calc((100dvh - 190px) * 16/9))`, and
  the whole player fits without scrolling from 844x390 down to 740x360.

**Video:** `<video src="/apps/session-manager/promo.mp4?v=2"
poster="/apps/session-manager/promo-poster.jpg" preload="metadata" playsInline>`, **but `src`
and `poster` are only set once the dialog first opens** (then kept). The dialog is always
mounted, so without that every page view would download the 412 KB 1920x1080 poster and the
MP4's first range before anyone clicks "Watch it run". They are set during the render that
opens the dialog, so the open effect's `play()` still runs inside the click's user gesture.

- There is **no `controls` attribute**. Captions are burned in, so there is no `<track>`; keep
  the existing lint comment.
- The fallback content is `film.videoFallback` plus a link `film.videoFallbackLink` to the MP4.

**The custom controls drive the element directly:**

| Control | Behaviour |
| --- | --- |
| Play/pause (40x40 rust; 44x44 in reflow) | `video.paused ? video.play() : video.pause()`; after `ended`, set `currentTime = 0` first. `aria-label` is `film.aria.play`, `pause` or `replay`. It reflects `play`/`pause` events and never uses local guesses. |
| Frame click | Toggles play, as in the mock. It is not focusable, because the Play button is the keyboard path. The big-play overlay (104px rust disc, scrim) shows while paused and not ended, and is `aria-hidden`. |
| Time / duration | `formatTime(currentTime)` from `timeupdate` (plus `requestAnimationFrame` while playing, for a smooth knob). Duration comes from `loadedmetadata`, with `film.durationFallback` "0:57" until then. Both are `aria-hidden`; the slider carries the value. |
| Seek | `role="slider"`, `aria-label` "Seek", `aria-valuemin` 0, `aria-valuemax` = duration, `aria-valuenow`, `aria-valuetext` from "{now} of {total}", `tabIndex=0`. Pointer: down, drag with `setPointerCapture`, and click all use `getBoundingClientRect()` ratios, which stay correct under the canvas scale. Keys: ←/→ ±5 s, PageUp/PageDown ±10 s, Home/End. Fill and knob are driven by inline `width`/`left` %. |
| Speed | Cycles 1 → 1.5 → 2 → 1 by setting `video.playbackRate`. Labels come from `film.speedLabels`, and `aria-label` from "Playback speed {rate}". |
| Sound | Toggles `video.muted`. The visible label is `SOUND ON` / `SOUND OFF` (current state). There is no aria-label override, so the name equals the visible text. |
| Fullscreen | `stage.requestFullscreen()` (falling back to `webkitRequestFullscreen`), where **stage = the video frame plus its controls bar**, never `document.documentElement`. `:fullscreen` CSS makes the stage fill the screen: frame `flex:1`, video `object-fit:contain`, controls pinned to the bottom. On iPhone Safari (no element fullscreen), fall back to `video.webkitEnterFullscreen()` (native player). The label toggles `FULL SCREEN` / `EXIT FULL SCREEN` on `fullscreenchange`. |

**Autoplay:**

- On open, set `currentTime = 0` and call `play()` (the click is the user gesture, so sound is
  allowed).
- **Under `prefers-reduced-motion: reduce`, never autoplay**: open paused on the poster with
  the big play showing.
- If `play()` rejects, stay paused with the big play showing.

**End card:** an HTML overlay (`position:absolute; inset:0` inside the frame, with the paper
dot grid) shown on the video's `ended` event.

- It is hidden again on `play`, and on `seeking` to before the end.
- Its content comes from `endCard.*`: badge, headline, body, the shared copy button, "Read the
  Field Manual →" and "Watch again" (`currentTime = 0; play()`). The manual CTA is an
  `<a href>` to the manual; it closes the dialog, then navigates.
- Clicks inside it do not toggle play.
- In reflow below 640px wide **or 500px tall** the 16:9 frame is too short for the end card
  (about 219px at 390x844; 190px at 844x390, where the card lost its badge, headline and both
  CTAs). On `ended` the stage (`data-ended`) takes the full width, the frame drops its
  `aspect-ratio` (below 640px wide, `min-height` = the 16:9 height), and the end card becomes
  `position:static` so the frame grows to fit; the dialog scrolls if it must. The headline uses
  `clamp(28px, 7vw, 52px)` (`clamp(28px, 9vh, 52px)` and gap 12 when short), and the buttons
  wrap. As a guard in every mode the end card is `justify-content: safe center;
  overflow-y:auto`, so content can never be centred off the top of the frame.

**Keyboard and focus:**

- On open, focus moves to the Play/Pause button.
- Tab cycles within the dialog, because `showModal()` makes the page inert.
- Escape uses the native `cancel` event: pause, close, and return focus explicitly to the
  "Watch it run" button (older Safari doesn't restore focus on its own).
- A `keydown` listener on the dialog toggles play on **Space only when
  `event.target.closest('button, a, input, [role="slider"], [tabindex]:not(dialog)')` is null**,
  which means focus isn't on a control. On a control, Space does its native job. There is
  **no** window-level key listener.
- Closing always pauses the video.

## Accessibility

- **Landmarks:** `<header>`, `<main>` (hero, price tag, Parts Bin) and the dialog.
- **Headings:** h1 is the hero, h2 is "The parts bin" and the film title, and h3 is the tab
  title.
- **Decorative elements (all `aria-hidden`):** stripes, S tile, pin, string, hole, "free!",
  ghost number, tape, `+` and ✦ glyphs, thumbnails, big play, "ESC".
- **Focus:** `:focus-visible` is a 3px solid rust outline with offset 3px. It turns **ink** on
  mustard or rust surfaces (active tab, price tag, copy buttons, play control), because rust on
  mustard is 3.7:1. In the dark film dialog it is **mustard**. Never use `all:unset` (the
  mock's buttons do, which kills focus rings). Reset explicitly instead: `appearance:none;
  background:none; font:inherit; color:inherit`.
- **Tablist:** arrow keys and roving tabindex, as described [above](#parts-bin-tabs).
- **Dialog:** focus trap via `showModal()`, focus restored to the trigger, Escape closes, and
  Space is scoped as above.
- **Reduced motion:** no autoplay, and every `transition` is disabled. The static rotations
  stay, because they don't move.
- **Contrast:** every text pair is at least 5.3:1 (see the token table).
- **Zoom:** the canvas yields to reflow as zoom grows (see the [canvas rule](#layout-mode-the-desktop-canvas-rule)).
- **Live status:** one `role="status"` region for copy results.

## CSP

The live policy is in `server/security-headers.ts:26-50`. It is Report-Only unless
`BILKO_CSP_ENFORCE=1`, but build for the enforced policy.

- **No runtime `<style>` elements.** `style-src` is nonce-gated for elements, and nothing on
  this page has the nonce. All CSS, including `:fullscreen`, `::backdrop`, hover and active
  states and any keyframes, lives in **`src/styles/session-manager-landing.css`**, imported by
  the page.
  - Vite code-splits it with the lazy chunk and loads it as `<link rel="stylesheet">` from
    `'self'`.
  - `pnpm dev` injects `<style>` tags, which is dev-only and irrelevant to the policy.
- **Inline style attributes** carry only runtime numbers: canvas scale and offsets, seek fill
  and knob. `style-src-attr 'unsafe-inline'` allows them.
- **Fonts:** load through a **page-scoped `<link>`** added by `usePageFonts()`, not through
  `index.html:26`, which would add weight to every bilko.run page. On mount it appends:
  - `<link rel="preconnect" id="smlp-preconnect-css" href="https://fonts.googleapis.com">`;
  - `<link rel="preconnect" id="smlp-preconnect-files" href="https://fonts.gstatic.com" crossorigin>`;
  - `<link rel="stylesheet" id="smlp-fonts" href="https://fonts.googleapis.com/css2?family=Source+Serif+4:ital,opsz,wght@0,8..60,400;0,8..60,600;0,8..60,700;1,8..60,400;1,8..60,600;1,8..60,700&family=Inter+Tight:wght@400;500;600;700&family=JetBrains+Mono:wght@400;600;700&display=swap">`.

  It skips any link whose id already exists and removes the ones it added on unmount. The policy
  already allows both origins (`style-src` has `fonts.googleapis.com` and `font-src` has
  `fonts.gstatic.com`). Update the origin comment at `security-headers.ts:17-19` to name the
  page-scoped families.
- **No new origins.** The video and poster are `'self'` (`media-src` falls back to
  `default-src 'self'`). The TOC fetch is `'self'`. Clerk is already allowed.
- **Global selectors:** every selector is under `.smlp-root` or `.smlp-film`. There are no bare
  `a`, `body` or `html` rules. The mock's global `a{…}` and `html,body{overflow:hidden}` must
  not be ported, because the stylesheet stays loaded after SPA navigation. The one body change
  is the inline, canvas-only overflow lock described under the
  [canvas rule](#layout-mode-the-desktop-canvas-rule).

## Truth guard (runtime)

`useManualToc()` fetches once on mount through `fetchManualToc()` and exposes `toc | null`.

- **Chapter count:** `toc.chapters.length`, or `subtitleFallback` while loading or on failure.
- **Chapter titles:** the TOC title by slug, otherwise the copy title.
- **Free flags:**
  - `allFree = toc.chapters.every(c => c.free)`. If `allFree === false`, the header link uses
    `manualLinkNotFree`.
  - For each aside, `chapterFree = tocChapter?.free`. If it is `false`, hide the FREE chip and
    use `aside.linkNotFree` and `chapterLinkNotFreeTemplate`.
  - With no TOC (loading or failed), render the free wording. That is correct under the
    [ship gate](#ship-gate-follows-from-decision-1).

"free!", the price tag and the end-card body are about the **app** and are always true.

## Tests (Bilko)

The current guards pin the old paid-manual page, so they must be **rewritten deliberately**,
not deleted. The free-manual change owns `ManualPage`'s case.

1. **`tests/open-core-positioning.test.ts`, marketing-page cases.** Read both
   `SessionManagerPage.tsx` and `session-manager-landing/copy.ts`.
   - **Required strings:** `npx claude-code-session-manager@latest`, `free, and stays free.`
     and `MAC · LINUX`.
   - **Forbidden strings:** `WINDOWS`, `$19.99`, `PRICE_LABEL`, `while we're in alpha`,
     `line-through`, `startSessionManagerCheckout`, `Buy`, `Purchase`, `Nothing gets
     uploaded`, `nothing leaves`, `Runs entirely on your machine`, `contradict`, `Search every
     session`, `Export a transcript`, `Rename a tag`, `between versions`.
   - **Retired surfaces:** keep the existing check, and apply it to the `/projects` hub card
     too (`ProjectsPage.tsx`, the session-manager entry in `projectsView.ts`).
   - **Identity:** the page has no `type="email"`. `AccountChip` reads `primaryEmailAddress`
     and uses `SignInButton`. No email literal matches `/[\w.+-]+@[\w-]+\.[\w.]+/` in page,
     copy or component source (comments stripped).
   - **Clerk isolation:** only `AccountChip.tsx` imports `@clerk/clerk-react` **or** calls
     `usePageView`; `SessionManagerPage.tsx` calls no Clerk hook; `Chip` and `PageViewBeacon`
     each sit directly inside a `QuietBoundary` that renders `null` on error.
   - **The reader sells nothing:** `ManualPage.tsx` (comments stripped) carries no checkout,
     price, `Buy`/`Purchase`/`Unlock`, `Sign in to`, `SignInButton`, 🔒 or `entitled`, and its
     download links render for everyone.
2. **New `tests/session-manager-landing.test.ts`:**
   - **Copy shape:** 9 tabs with unique keys, 3 bullets and 3 points each, and no empty
     strings.
   - **Chapters:** every `chapter.slug` exists in the **newest** `data/manual/releases/*/manifest.json`,
     and `chapter.title` equals that manifest's title. A future manual release that renames or
     drops a chapter fails here and forces a copy review.
   - **Layout mode:** `layoutMode()` against the anchor table above.
   - **Time format:** `formatTime` (0 → `0:00`, 57.002 → `0:57`).
3. **Optional `e2e/session-manager-landing.spec.ts`** (the Playwright config already runs
   `pnpm dev` on :3002, a port reserved for the visual verifier in this workstream):
   - 1440x860 and 390x844 renders;
   - arrow keys across the tablist;
   - the dialog opens, Escape closes, and focus returns to "Watch it run";
   - nothing overflows horizontally at 390.

Verification loop: `pnpm typecheck`, then `npx vitest run tests/open-core-positioning.test.ts
tests/session-manager-landing.test.ts tests/session-manager-urls.test.ts`, then `vite build`.

## Chapter map

These are Field Manual 2.0.x slugs. They are identical in 2.0.0 and 2.0.1, and in 2.0.1 every
one is `free: true`. The link is `/products/session-manager/manual#<slug>`. Points paraphrase
the chapter's own section headings and text.

| # | Tab | Slug | Real chapter title | Points (paraphrased from) |
| --- | --- | --- | --- | --- |
| 01 | Sessions | `first-session` | Your first Session — from idea to working agent | "Install and take the tour"; "Give your agency its first job"; "Watch it work" (Chat and Terminal are two views of one session) |
| 02 | Scheduler | `plans-and-scheduler` | Work that runs while you're away — plans and the Scheduler | "From your idea to a queue of work orders"; "Its own copy of your project"; "How many run at once" (pauses near the usage limit, resumes at the reset) |
| 03 | Agent Library | `agents-and-missions` | Shaping your team — Agents, Missions and one-click Actions | "Write an agent in plain English"; "Picking a model — and what it costs"; "Actions — a favorite agent, one click away" |
| 04 | Tag Library | `agents-and-missions` | Shaping your team — Agents, Missions and one-click Actions | "Missions — what kind of work a Session is"; the Feature/Bug/Discussion "What it sets up" table; "the built-in list is fixed on purpose" |
| 05 | Memory | `cockpit-tour` | Around the cockpit — Home, memory, usage, history and more | "Memory" (notes read back in a later Session; project vs one agent); "The Clusters report" |
| 06 | History | `cockpit-tour` | Around the cockpit — Home, memory, usage, history and more | "Usage meters" (five-hour and weekly); "History" (cost and usage over time; range + measure → trend) |
| 07 | Skills · Hooks · MCP | `new-abilities` | New abilities — skills, plugins, tools and hooks | the Ability / What it is / When to use it table; "Hooks" (test fire); "MCP Servers" (test connections) |
| 08 | Voice | `cockpit-tour` | Around the cockpit — Home, memory, usage, history and more | "Voice input" (transcribed on your own machine); "The recording indicator" (the red bar) |
| 09 | The whole kit | `welcome` | Welcome — your friendly map of what's ahead | "Claude Code, in one breath"; "What Session Manager adds"; "How this manual is organized" (three parts) |

`meet-your-agency`, `checking-the-work`, `house-rules`, `good-habits`, `what-is-an-agent`,
`claude-code-basics` and `glossary` stay reachable from the manual itself. `welcome` was chosen
over `good-habits` for "The whole kit" because it covers exactly that tab's claims: what the
app adds, that it is free, and one `npx` command on Linux or macOS.

## Changed lines

Every line not listed here is the design's text **verbatim**. Evidence paths are
session-manager (`sm:`) or Bilko (`bilko:`) repo paths.

### Header, hero, CTAs, price tag, end card

| Where | Design | Final | Reason | Evidence |
| --- | --- | --- | --- | --- |
| Header chip | A personal email address (the mock's `account` default; `you@example.com` in the saved copies) + hard-coded "B" | Signed in: avatar initial + the user's email (via `useUser`). Signed out: "Sign in" | The mock's default is a personal address, and the chip had no signed-out state | V2:38, V2:201, V2:244; bilko:`src/components/Layout.tsx:90-103` |
| Header link | `Field Manual (it's free) →` | Unchanged, true now. `Field Manual →` only if the TOC reports a non-free chapter | Owner decision 1 makes it true; the truth guard covers deploy order | bilko:`data/manual/releases/2.0.1/manifest.json` (13/13 free) |
| Hero paragraph, last sentence | `All on your own laptop.` | `The app runs on your own laptop.` | Prompts go from Claude Code to Anthropic, and anonymous telemetry to bilko.run is on by default. The app itself is local. | sm:`README.md:47,50`; sm:`src/main/lib/telemetrySettings.cjs:35-38` (`enabled: true`, endpoint bilko.run) |
| Manual CTA subtitle | `17 chapters of tips & tricks` | `{n} chapters of tips & tricks` (live, 13 today); fallback `tips & tricks, every chapter free` | 17 matches no current release. The count must come from `/api/manual/toc`. | bilko:`data/manual/releases/2.0.1/manifest.json`; bilko:`server/routes/manual.ts:42-49` |
| Price tag | `$0` + struck-through `$19.99` | `$0` only | A struck price implies the app will cost money. $19.99 was only ever the manual's price. | sm:`CLAUDE.md` open-core law; bilko:`shared/manual-catalog.ts` (HEAD: `MANUAL_PRICE_LABEL = '$19.99'`) |
| Price tag line | `free while we're in alpha.` | `free, and stays free.` | Owner decision 2; the open-core law | sm:`CLAUDE.md` ("the APP is free and stays free … never … trial limit … 'pro' tier") |
| Platforms | `MAC · WINDOWS · LINUX` | `MAC · LINUX` | npm refuses install on win32, and the launcher exits | sm:`package.json:107-110` (`os: [darwin, linux]`); sm:`bin/cli.cjs:9-12` |
| Price tag note | `Paste it into your terminal and you're off.` | `Node 22.12+, Claude Code signed in? Paste & go.` (47 chars, 270px at 13px Inter Tight, one line in the tag's 308px content box — 352px minus 2px borders and 20px padding; the design's is 43) | The command runs through `npx`, and Claude Code's native installer does not bring Node, so a learner who only installed Claude Code gets `npx: command not found`. The floor is 22.12, not the `engines: >=18` the package carried since v0.8.3 (now `>=22.12.0`). Electron 42 has no postinstall: the first `require('electron')` downloads the binary by running `install.js`, which `require()`s `@electron/get` 5, an ES module. Electron, `@electron/get` and `@electron/rebuild` all declare `engines.node: >=22.12.0`; on Node 18 that `require()` throws ERR_REQUIRE_ESM, so the app never starts. `Node 22+` would be false for 22.0–22.11. The app drives Claude Code, so it also needs Claude Code installed and signed in; the manual's own first chapter lists that prerequisite. | sm:`package.json:102` (`engines.node: >=22.12.0`), sm:`package.json:132` (`electron: 42.1.0`); `electron@42.1.0` `package.json` (`engines.node: >= 22.12.0`, no `scripts`), `index.js:7-17,25-50` (lazy `downloadElectron()`), `install.js:3` (`require('@electron/get')`); `@electron/get@5.0.0` (`"type": "module"`, `engines.node: >=22.12.0`); `@electron/rebuild@4.0.4` (same); sm:`bin/cli.cjs:17-29` (below the floor it now names Node, not the network); sm:`tests/unit/node-floor.spec.ts` (pins engines, README and this note to the deps' floor); sm:`README.md:32`; bilko:`data/manual/releases/2.0.1/first-session.html` ("What you need first") |
| Copy button (new state) | none; showed "Copied" even on failure | `Couldn't copy — select it above` (end card: `…select it below`) | The mock's copy was optimistic (`.catch(()=>{})`). The failure state needed true words. | V2:260 |
| Film frame | `YOUR 57-SECOND FILM PLAYS HERE · 16:9` placeholder, simulated timer | The real `<video>` (promo.mp4?v=2, 57.002 s), with fallback text `Your browser can't play this film here.` | The film exists | bilko:`public/apps/session-manager/promo.mp4` (ffprobe 57.002 s) |
| Duration | hard-coded `0:57` | from `loadedmetadata`, fallback `0:57` | Real media | V2:190 |
| Fullscreen | `FULL SCREEN` fullscreened the whole page | `FULL SCREEN` / `EXIT FULL SCREEN` on the video stage | Fullscreen targets the frame, not the page | V2:254 |
| End-card body | `Want to take it for a spin? It's free while we're in alpha.` | `Want to take it for a spin? It's free, and it stays free.` | Owner decision 2 | as above |

### Parts Bin tab copy

| Where | Design | Final | Reason | Evidence |
| --- | --- | --- | --- | --- |
| Scheduler body | `The scheduler knows when your usage window resets and fires your queued prompts right on time — so the big stuff runs when you've got the most room.` | `The scheduler watches your usage window and starts queued jobs whenever there's room — and if you hit the limit, it pauses and picks back up at the reset.` | The default policy is when-available (fire under 90% utilization), not a timed fire. It runs PRD jobs, not typed prompts, and auto-resumes at the reset. | sm:`src/main/scheduler.cjs:997-1008`; sm:`src/renderer/components/tabs/scheduler/FirstRunGuide.tsx:16` |
| Scheduler bullet 2 | `Line up prompts to run the moment it resets` | `Hit the limit? It pauses, then resumes at the reset` | `on-reset` fires 15 min after the reset and is labelled legacy. Auto-resume is the real behaviour. | sm:`src/main/scheduler.cjs:998-1003`; sm:`README.md:67-68` |
| Agent Library bullet 1 | `Start from a template or write your own` | `Start from a bundled persona or a blank page` | No template picker exists. There are 4 seeded personas, "+ New agent" and Duplicate. | sm:`src/seed/agents/`; sm:`src/renderer/components/tabs/AgentLibrary.tsx:91,312,576` |
| Agent Library bullet 3 | `See exactly what changed between versions` | `Let one project swap the model, no fork needed` | There is no version history or diff. Per-project model/effort overlays are real. | sm:`src/renderer/components/tabs/AgentLibrary.tsx:274-292,549-561` |
| Tag Library title | `Find that one brilliant prompt again.` | `Name the job before Claude starts it.` | The Tag Library holds missions, not prompt search. A mission is picked at creation and its framing is sent before the goal. | sm:`src/renderer/components/tabs/TagLibrary.tsx:249-252` |
| Tag Library body | `Tag sessions, prompts and agents as you go. Next month, the trick you figured out today is one click away.` | `A small, fixed set of missions — Feature, Bug, Discussion and friends. Every session gets one, and your agents carry the missions they suit.` | There are 6 read-only tags, one per session, and agents carry a `tags:` list. There is no prompt tagging. | sm:`src/renderer/lib/tagLibrary.ts:10,31-80`; sm:`TagLibrary.tsx:20-39` |
| Tag Library bullets | `Tag anything — sessions, prompts, agents` / `Mix tags to filter your history` / `Rename a tag once, it changes everywhere` | `One mission per session, chosen up front` / `Group your sessions by mission at a glance` / `Match agents to missions from either side` | There is no multi-tag filter (History has no tags) and no rename (closed union). Group-by-tag and two-sided agent↔tag assignment are real. | sm:`src/renderer/lib/epicQueueControls.ts:13-15`; sm:`TagLibrary.tsx:20-39` |
| Memory body | `Every memory file — for one project or all of them — in one tidy place. …` | `Every memory note — per project, and per agent — in one tidy place. …` | The Memory tab has Workspace (per project) and Subagent (per agent) scopes. Global CLAUDE.md is a different screen. | sm:`src/renderer/components/tabs/Memory.tsx:20-36`; sm:`src/main/agentMemory.cjs:9` |
| Memory bullets | `Browse memory by project or globally` / `Edit with a live preview` / `Spot instructions that contradict each other` | `Browse memory by project or by agent` / `See related notes grouped into clusters` / `Spot stale notes that point at missing files` | There is no preview in the Memory editor and no contradiction detection. Staleness (dead path refs) and clusters are real. | sm:`src/main/lib/memoryStale.cjs:90-100`; sm:`src/renderer/components/tabs/memory/MemoryClustersPanel.tsx:1-9` |
| History title | `Everything you've done, searchable, on your laptop.` | `Every token, dollar and hour, tallied on your laptop.` | History is analytics (measures in/out/total/prompts/sessions/time/spend), not search. It is computed locally. | sm:`src/renderer/components/tabs/HistoryDashboard.tsx:26-29`; sm:`src/main/historyDashboard.cjs:1-11` |
| History body | `Search every session you've ever run and reopen any of them right where you left off. Nothing gets uploaded anywhere.` | `Estimated spend, tokens and active time for every project, by model and by day — built from the transcripts already on your disk.` | There is no search or resume in History. "Nothing uploaded" is false with default-on telemetry. Spend is estimated from a pricing table. | sm:`src/main/historyAggregator.cjs:10-30`; sm:`README.md:47` |
| History bullets | `Search by words, tags or project` / `Jump back into any session mid-thought` / `Export a transcript in one click` | `Chart spend, tokens or time, 30 days to all time` / `Rank your projects, then drill into one` / `Export the numbers to CSV in one click` | Ranges are 30/60/90/all, with Ranking and ProjectDrill. The export is a usage CSV, not a transcript. | sm:`HistoryDashboard.tsx:27,254-280`; sm:`src/renderer/components/tabs/history/analytics/ControlBar.tsx:79-82` |
| Skills · Hooks · MCP body | `Skills, hooks and MCP servers side by side, with on/off switches. …` | `Skills, hooks and MCP servers, each a click away — toggle skill auto-use, test your servers. …` | These are three separate screens, and hooks have no per-hook switch. The skill toggle only sets `disable-model-invocation`, so a switched-off skill still runs from its slash command: "flip skills … on or off" overclaimed it. MCP servers get no on/off claim: the tab's `enabled` checkbox writes a per-server `enabled: false` key that Claude Code never reads, so a server shown as off still loads (the CLI's own switch is `disabledMcpServers`). That made an earlier "toggle … servers. … no guessing what's switched on" false. "Test your servers" is real: `⟳ test connections` probes every server with `claude mcp list`. | sm:`src/renderer/lib/navGroups.ts:72-75`; sm:`Skills.tsx:39,161-164,181`; sm:`McpServers.tsx:264-270,531-541`; sm:`src/main/mcpStatus.cjs:3-10`; Claude Code 2.1.283 probe with a scratch `CLAUDE_CONFIG_DIR`: `claude mcp get` reports `✘ Failed to connect` (loaded) for `enabled: false`, but `⊘ Disabled for this project` under `disabledMcpServers` |
| Skills · Hooks · MCP bullet 1 | `Switch skills on and off per project` | `Switch your skills' auto-use on or off` | The toggle writes `disable-model-invocation` into the skill's own SKILL.md, which is user-wide for user skills, and only stops auto-use. It covers the skills under `~/.claude/skills` and `<project>/.claude/skills` only; plugin skills (the app's own bundled dev skills included) are read-only, so "any skill" overclaimed. | sm:`Skills.tsx:24-29,108-110,161-177`; sm:`Plugins.tsx:66-71`; sm:`src/main/seedDevPlugin.cjs:4` |
| Voice bullet 2 | `Transcribed locally — it stays on your laptop` | `Transcribed locally — audio stays on your laptop` | Audio never leaves (Moonshine ONNX in a Web Worker), but the transcribed text becomes a prompt that goes to Anthropic | sm:`src/renderer/lib/whisperWorker.ts:1-27`; sm:`src/renderer/lib/speechRecognition.ts:188-251` |
| Whole kit body | `… And it's free while we're in alpha.` | `… And it's free, and it stays free.` | Owner decision 2 | sm:`CLAUDE.md` open-core law |
| Whole kit bullet 2 | `Runs entirely on your machine` | `Runs on your machine; telemetry is anonymous and opt-out` | Default-on anonymous telemetry, opt-out via Settings or `SM_TELEMETRY=0` | sm:`README.md:47`; manual `cockpit-tour` "Anonymous telemetry" |
| Whole kit bullet 3 | `Free for the whole alpha — one command to install` | `Free, and stays free — one command to install` | Owner decision 2 | as above |
| All 9 chapter cards | Invented titles (`Sessions without the mess` … `Your first week, start to finish`) and 27 invented points | Real 2.0.x titles and paraphrased real headings ([Chapter map](#chapter-map)) | None of the 9 design titles exists in any manual release | grep across bilko:`data/manual/releases/*` returns 0 hits |

**Kept verbatim and re-verified as true:**

- Tagline, ALPHA, audience pill and headline.
- The rest of the hero paragraph: sessions resume one claude session each; the scheduler waits
  out the limit; Configure holds every setting.
- Film card text (57.002 s, "Pip and the Paper Moon" per sm:`web/promo-video/script/BRIEF.md:1`).
- Every Sessions line (1:1 session, Chat and Terminal share one sessionId, the 5-level
  verbosity dial in sm:`src/renderer/lib/chatVerbosity.ts:20-37`).
- Scheduler title and bullets 1 and 3.
- Agent Library title, body and bullet 2.
- Memory title.
- Skills title and bullets 2 and 3 (the hooks editor with test-fire, and MCP test connections).
- All Voice lines except bullet 2 (hold is the default mode; the transcript is editable and the
  8 s auto-submit can be cancelled).
- The whole-kit title and bullet 1.
- "FROM THE FIELD MANUAL", "FREE", "Read this chapter free →", "Read the Field Manual →",
  "THE END (FOR NOW)", "That's the whole tour." and "Watch again". Every "free" claim here is
  true under decision 1 and the ship gate.

## Dropped / deferred (named explicitly)

- **The mock's props:** `stripes` is fixed on in canvas and off in reflow. The `account`
  default is never shipped.
- **Upscale cap:** none, per the canvas rule. Revisit only if 1.26x at 1920x1080 reads as too
  large in review.
- **Tab ↔ URL sync** (`?part=` or a hash): not in v1.
- **Per-section deep links** inside `cockpit-tour` and `agents-and-missions`: chapter HTML has
  no ids and the reader has no sub-anchor support. That needs a manual release, not a landing
  edit.
- **Signed-in chip menu or sign-out:** the chip is display-only, and sign-out lives in the site
  Layout.
- **OG/meta override for `/products/session-manager`** (bilko:`server/index.ts:230`): optional
  and separate.
- **Registry card copy** in bilko:`src/config/tools.ts` and `src/data/packages.ts`: owned by
  the free-manual change, not this page.

## 2026-10-05 — price tag carries download buttons, not the npx command

The price tag now carries download buttons (Mac, Mac Intel, Windows, all releases) instead of
the `npx` install command and its copy button. `priceTag.command*`, the copy/copied/failed
labels, the copy-related aria keys and `meta.installCommand` are removed from `copy.json`;
`priceTag.platforms` is "MAC · WINDOWS". Why: the installers bundle Node and Electron, so
visitors no longer need Node or a terminal, and the app's Setup checklist installs git and
Claude Code on first launch. The Price tag / Copy button sections above describe the retired
npx layout and are superseded by `copy.json` where they differ. The end-card copy keys are
unchanged here.

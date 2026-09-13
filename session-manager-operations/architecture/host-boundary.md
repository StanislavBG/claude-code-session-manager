# Host boundary — what Bilko legitimately owns vs. what is ours, misplaced

> Bilko is a **host platform, not a product** (`~/Projects/Bilko/CLAUDE.md` TL;DR). Every question
> about our web presence currently gets routed to Bilko as if it were our web team — because our
> marketing page, Field Manual reader, relay, and Stripe product key all live in that repo as
> first-class in-repo code. This doc draws the line: the precise, defensible boundary between what
> the host legitimately owns and what is ours, misplaced, so the extraction staged by
> [`project-partition.md`](project-partition.md) (the WEB PRESENCE partition, physically collected
> under `web/` by PRD 1184) has a target instead of a vibe.
>
> Argued from the HOST's own stated contract — `~/Projects/Bilko/CLAUDE.md` and
> `~/Projects/Bilko/docs/host-contract.md` — read READ-ONLY for this doc, never edited by it.

## File-by-file classification

Every file verified by reading it in full on 2026-09-12. Quotes are Bilko's own words.

| File (in `~/Projects/Bilko`) | Verdict | Justification (quoting Bilko's own contract) |
| --- | --- | --- |
| `src/pages/SessionManagerPage.tsx` | **OURS-MISPLACED** | Host's own rule: *"New apps default to `static-path` (own repo). Use `react-route` only when an app genuinely needs to live in this bundle (rare)."* This page needs Clerk sign-in + a Stripe checkout call — but the 8 AI-tool siblings prove that doesn't require `react-route`: they are `static-path` and *"call their endpoint same-origin via Clerk JWT — no CORS, no cross-origin auth"* (host-contract.md, gateway pattern). The `FEATURES` array (our tab-by-tab pitch copy) is pure product knowledge with no host dependency at all. |
| `src/pages/ManualPage.tsx` | **OURS-MISPLACED** (reader UI) | Same gateway precedent: *"each ship their React page from the sibling repo, but their ... endpoint stays in Bilko host."* The reader's UI (TOC rendering, chapter switching, buy button chrome) is presentation, not entitlement — it only *consumes* `manualClient.ts`'s calls. |
| `src/lib/manualClient.ts` | **OURS-MISPLACED** | Pure browser fetch wrapper with "no React or Clerk import" by its own doc comment — moves with the page, calls the host's `/api/manual/*` gateway same-origin exactly as `useToolApi()` does for the 8 tools. |
| `src/lib/sessionManagerCheckout.ts` | **OURS-MISPLACED** | Same shape as `manualClient.ts` — a thin fetch wrapper around `/api/stripe/create-checkout-session`. Moves with the pages; the endpoint it calls stays host-side (below). |
| `server/routes/manual.ts` | **HOST-LEGITIMATE** (gateway endpoints) + one OURS-flavored piece | The `/api/manual/toc`, `/status`, `/chapter/:slug`, `/download/:assetId` routes exist to answer *"is this email entitled?"* — host-contract.md: *"Payments: Stripe. ... one-time purchases via `hasPurchased(email, productKey)` ... from `server/services/stripe.ts`"* is a host-provided service, by name. The `/products/session-manager/my-manual` recovery page rendered inline in this file is presentational HTML with our copy/branding — worth trimming during extraction, but the *function* (email-based entitlement lookup with no Clerk session) has the identical shape to the entitled routes above and needs the same host-side data access, so it stays. |
| `server/services/manual.ts` | **HOST-LEGITIMATE-BY-NECESSITY** | `isEntitledToManual()` calls `hasPurchased()` from `server/services/stripe.ts` — squarely host substrate. The bundle-reading half (`manualRoot`, `listManualVersions`, `readManifest`, `findChapter`, `resolveReleaseFile`, `readChapterHtml`) reads content **we** author, but it must live where the entitlement check runs (see "The paid-manual case" below) — this is authorship-OURS, hosting-necessarily-HOST, not a clean single verdict. |
| `server/sm-relay/router.ts` + `tokens.ts` | **HOST-LEGITIMATE** | Verified: the header's claim that it was "ported" from this repo's `web-remote/relay/src/router.ts` is true but stale — the two have diverged (this repo's `web-remote/relay/` is dead code per `project-partition.md`). host-contract.md treats the relay as a *documented host-side exception*: its own "What must NOT move under `/products/<slug>/`" section uses Session Manager's relay as the worked example, explaining the URL is *"baked into already-paired phones"* and must dual-serve via `RELAY_WS_PATHS`. CLAUDE.md's own law says *"The bilko.run relay stays live"* — this is host infrastructure by design, not leakage. It is a "dumb pipe" (its own header comment) that forwards opaque envelopes by `userId`/`deviceId` — it holds no knowledge of Session Manager's tabs, PRDs, or Epics. |
| `shared/manual-catalog.ts` | **SPLIT** | `MANUAL_PRODUCT_KEY = PRODUCT_KEYS.SESSION_MANAGER` is HOST-LEGITIMATE plumbing — it wires into the shared Stripe catalog by design (see next row). But `MANUAL_TITLE`, `MANUAL_PRICE_LABEL`, and the `ManualChapter`/`ManualManifest`/`ManualToc` interfaces describing our own content's shape are OURS-MISPLACED — none of that is needed by the host's checkout flow, which only needs the `priceType` string. |
| `session_manager` entry in `shared/product-catalog.ts` | **HOST-LEGITIMATE** | The file is host's *"single source of truth for Stripe products ... used by BOTH the frontend tool registry ... and the backend Stripe flow"* — shared substrate for every product (ContentGrade, PageRoast, PublicTrades, us). Our one entry (`SESSION_MANAGER: 'session_manager'` + its `PRICE_CATALOG` row: env var, product key, mode) carries zero business logic — it is exactly *"an entitlement row in the host's database ... the host doing its job, not leakage"* (per this PRD's own framing, echoing `shared/manual-catalog.ts`'s comment: *"there is no second SKU"*). |
| `src/config/tools.ts`'s `session-manager` entry | **OURS-MISPLACED** | The registry mechanism itself is host substrate (*"Single source of truth for all tools ... Everything downstream ... reads from here"*), and a minimal metadata row (slug/name/tagline/category/tags) is exactly what every registered app must provide per host-contract.md's "Every app" checklist — that sliver is legitimate. But this entry additionally carries a full `description`, a `features` array, and a `loader: () => import('../pages/SessionManagerPage.js')` wiring in a whole react-route page — that is product copy and page ownership sitting inside host's registry, not the one-line-per-app shape every other of the ~25 registered siblings uses. |
| `data/manual/` | **HYBRID — OURS content, HOST-LEGITIMATE storage** | Its own header comment: *"There is deliberately NO download-token machinery here ... every route ... checks that row directly"* and *"lives under `data/manual/`, NOT `dist/`, so the static plugin can never serve a chapter ... by guessed URL."* The bytes are ours (built by this repo's `web/manual/build.mjs`, per `manual-catalog.ts`: *"authored in the session-manager repo ... and committed into this repo"*), but they must be reachable by the same process that runs the entitlement check on every request — a public static file can't be gated per-request. See "The paid-manual case" below for the recommended shape. |
| `public/projects/session-manager/` | **HOST-LEGITIMATE** (already correct) | Already verified: its `manifest.json` records `gitSha: "69c1d7a"`, this repo's last `web-remote` commit — it is a **published artifact** of `web/remote-app/` (this repo), stored where a static-path sibling's bundle belongs. This is the existing, correct model: *artifact there, source here.* It is what the rest of this doc's recommendations are trying to replicate for the marketing page and manual reader. |

## The paid-manual case, worked through

This is the hardest case because the manual is genuinely a joint artifact: content we author, sold
through an entitlement the host alone can verify.

- **Reader UI** → **OURS**. `ManualPage.tsx` + `manualClient.ts` move to the sibling web repo,
  built as part of its static-path bundle (`web/remote-app/`'s sibling — the eventual
  `web/manual-app/` or folded into one combined bundle at `/projects/session-manager/`).
- **Entitlement check** → **HOST-LEGITIMATE**. `isEntitledToManual()` → `hasPurchased(email,
  'session_manager')` must stay host-side: it reads the `stripe_one_time_purchases` table that only
  the host process has a connection to, and it must run synchronously on every `/chapter` and
  `/download` request — not just once at publish time. This is the host "doing its job."
- **Bundle bytes** → **stay host-side, by necessity, not by default**. A signed-URL scheme was tried
  and explicitly rejected (`manual.ts`'s own comment: the earlier revision *"bought nothing except a
  `MANUAL_DOWNLOAD_SECRET` to configure, rotate, and keep in sync"*) in favor of fetching with the
  Clerk bearer header directly against the host route. That means the file bytes must live wherever
  that route runs — i.e., the host — because a public CDN-cached static file (the `static-path`
  model) cannot be re-checked against a purchase row on every read. **Recommendation:** treat
  `data/manual/releases/` the same way `public/projects/session-manager/` is already treated —
  a **published artifact directory**, fed by this repo's `web/manual/build.mjs` (source of truth
  here), copied into Bilko by the same kind of publish step the static-path siblings already use,
  just gated instead of public. Authorship stays ours; storage stays host-side because the gate
  requires it, not because the content is host's to write.
- **Candidate pattern evaluated**: the gateway pattern already documented in Bilko's own
  CLAUDE.md — *"each ship their React page from the sibling repo, but their ... endpoint stays in
  Bilko host"* — is the correct answer here too: sibling ships `ManualPage.tsx`; host keeps
  `server/routes/manual.ts` + `server/services/manual.ts` + `data/manual/`.

## Target end state

**The tension, named.** Host-contract.md gives `static-path` siblings the canonical URL
`/projects/<slug>/`, while `/products/<slug>` is reserved for in-repo `react-route`s — and yet
host-contract.md's *own* worked example for "a `react-route` app may own arbitrary sub-paths" is
**Session Manager itself**, showing `/products/session-manager`, `/products/session-manager/manual`,
`/products/session-manager/my-manual`, and `/products/session-manager/remote` all owned by one
product root. Extracting to our own repo (which the host's long-term direction — *"all in-repo apps
eventually become sibling repos"* — says we should) collides with that: `static-path` siblings don't
get to own a `/products/*` root; they get `/projects/<slug>/`. "Everything under
`/products/session-manager`" and "we own our pages in our own repo" cannot both be true long-term.

**Recommendation.** Follow the 8 AI-tool siblings' already-proven resolution, not the
sub-path-ownership pattern: migrate fully to `static-path` at the canonical `/projects/session-manager/`,
combining the marketing page, manual reader, and (once ready) the already-published web-remote PWA
into one sibling bundle, with `server/routes/manual.ts` + `server/routes/stripe.ts` staying host-side
exactly as they do for the other 8 tools. Do **not** try to relocate the static-path convention to
`/products/*` — that fights the host's own naming contract.

The receipt-link constraint host-contract.md already solved once (the relay) is the template for
retiring the old paths safely — its own words: *"Migrating such a path is a three-step sequence,
never a rename: 1) Host serves ... at both paths ... 2) The sibling publishes a new bundle pointing
at the new path. 3) Only then does the old path get retired."* And: *"The two legacy top-level paths
can never be deleted: they are printed in Stripe receipt emails already in customers' inboxes."*
Apply the identical sequence: `/products/session-manager/manual` and `/products/session-manager/my-manual`
become **permanent 301s** to `/projects/session-manager/manual` and `/projects/session-manager/my-manual`
— never deleted, exactly like `/manual` → `/products/session-manager/manual` is never deleted today.

**What Bilko retains after extraction:**
- `server/routes/manual.ts`, `server/services/manual.ts`, `server/services/stripe.ts` — the gateway
  endpoints (entitlement + checkout), reachable same-origin from the new bundle.
- `shared/product-catalog.ts`'s `session_manager` entry — the shared Stripe catalog row.
- `data/manual/releases/` — the gated bundle bytes, now fed by a publish step from our repo instead
  of hand-committed.
- `server/sm-relay/` (router + tokens) — the live relay, unconditionally, per CLAUDE.md's law.
- The `standalone-projects.json` registry row and the permanent 301s for the two legacy paths.

**What moves to the new web repo:**
- `SessionManagerPage.tsx`, `ManualPage.tsx`, `manualClient.ts`, `sessionManagerCheckout.ts`.
- `MANUAL_TITLE`/`MANUAL_PRICE_LABEL`/manifest-shape types out of `shared/manual-catalog.ts`.
- The `src/config/tools.ts` `session-manager` entry's `description`/`features`/`loader` — replaced
  by a minimal `static-path` registry row.

This target is downstream of, and does not restate, [`project-partition.md`](project-partition.md)'s
WEB PRESENCE partition (already physically collected under `web/` by PRD 1184) — it is the shape
that partition's producers should be building *toward* once `git subtree split --prefix=web` runs.

## Routing rule for future sessions

**Route to Bilko via `/send-feedback`** — host contract, shared auth, shared billing, publish
gates, serving infrastructure:
- A publish gate blocked by host-side misconfiguration or a missing host devDependency.
- A Clerk auth failure, a Stripe webhook/entitlement bug, a relay outage or protocol issue.
- A request to add/adjust a registry entry, budget, or redirect that only the host's `bilko-host`
  MCP can perform.

**Never route to Bilko — this is `/develop` here, or blocked on the extraction:**
- Our marketing copy, our feature descriptions, our page layout/UX.
- Our product's URL structure or route consolidation — deciding how `/products/session-manager/*`
  or `/projects/session-manager/*` should be organized is a call about **our** product's shape, not
  the host's. Only the mechanical registration/redirect steps that implement that decision belong to
  Bilko, via the `bilko-host` MCP, once the decision is made here.
- Our bundle bytes, our manual content, our Field Manual chapters.

**Worked example — 2026-09-12 misfire.** A session filed a URL-consolidation Epic against Bilko,
asking the *host* to restructure Session Manager's own product routes (the `/products/session-manager/*`
sub-paths documented above). That was ours to decide — this doc's "Target end state" section above
is the decision — and the only Bilko-facing action it should ever produce is the mechanical
redirect/registry change once we've decided the target, executed through the `bilko-host` MCP like
any other static-path publish, not as a proposal asking Bilko to design our routes for us.

## Publish gates currently blocking us

Both recorded in [`session-manager-operations/bilko-host/publish-state.json`](../bilko-host/publish-state.json)
(PRD 1146's publish attempt, 2026-09-11) and both are **HOST-LEGITIMATE** — host-side config/tooling
gaps, legitimate `/send-feedback` candidates once this PRD's scope closes (not opened by this PRD):

- **`budget` gate**: `app_budgets.max_size_gz_bytes` is `195000` for slug `session-manager`, below
  the already-live bundle's own declared `1072016` bytes — host-contract.md documents this exact
  failure mode by name: *"A budget below what is already live for that slug is a dead gate ...
  `session-manager` sat in exactly that state (195 KB budget vs a live 1,072,016-byte bundle)."*
  The `OVERSIZE_BUDGETS` raise-if-lower upsert Bilko built to fix this class of bug evidently hasn't
  been applied (or re-applied) to our row. Host's data, host's fix.
- **`a11y` gate**: blocked on `playwright not installed — run: pnpm add playwright` — a missing
  devDependency in `~/Projects/Bilko` itself, not this repo (publish-state.json's own note: *"host-repo
  tooling gap in ~/Projects/Bilko, not this repo"*).

## Related docs

- [`project-partition.md`](project-partition.md) — this repo's 4 partitions; WEB PRESENCE is the
  partition this doc's target end state applies to.
- [`web/README.md`](../../web/README.md) — the physical staging area for WEB PRESENCE producers,
  pending `git subtree split --prefix=web`.
- [`bilko-run-marketing.md`](bilko-run-marketing.md) — the pre-existing, narrower doc on the current
  (pre-extraction) product page/checkout/npm-listing shape; this doc supersedes it for boundary
  questions but does not replace its operational detail.

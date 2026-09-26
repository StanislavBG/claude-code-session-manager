# bilko.run marketing page + retained Stripe wiring

> Extracted from `CLAUDE.md` on 2026-08-24; rewritten 2026-09-25 when the buy flow was removed. Lives in
> the sibling repo `~/Projects/Bilko/`, not here. Read before touching anything about the product page,
> the retained Stripe wiring, or the npm listing.

> **Owner decision, 2026-09-25:** the app and the Field Manual are both free (Field Manual 2.0.1, every
> chapter `free: true`, free PDF/offline downloads). Nothing is for sale: no buy UI anywhere, and never
> rebuild one. Past buyers keep their entitlement rows.

This repo ships the app only. The public marketing page at **bilko.run/products/session-manager** (hero,
feature Parts Bin, the app's `$0` price tag + install command, links into the free Field Manual) and the
npm-package registry entry (`Session Manager` card on bilko.run/projects) live in a **separate sibling
repo**: `~/Projects/Bilko/` (git remote `origin` → `StanislavBG/bilko-run`, **not** `content-grade`). Bilko
is Stanislav's own multi-project *hosting platform* — the App-Store-style host for bilko.run — not a
third-party service, so issues with the product page are ours to fix, just in that repo.

Key files in `~/Projects/Bilko/` for session-manager's listing:
- `src/pages/SessionManagerPage.tsx` + `src/pages/session-manager-landing/` — the product page. It sells
  nothing: no checkout, no email form, and the only price on it is the app's `$0`. Every visible string
  lives in `session-manager-landing/copy.ts`, mirrored from this repo's
  [`design-mocks/landing-v2/copy.json`](../design-mocks/landing-v2/copy.json) — edit there first.
- `src/pages/ManualPage.tsx` + `server/routes/manual.ts` — the free Field Manual reader at
  `/products/session-manager/manual`; every chapter and every download is public.
- `src/lib/sessionManagerCheckout.ts` — **deleted** 2026-09-25 with the buy flow.
- `server/routes/stripe.ts` — `POST /api/stripe/create-checkout-session` answers **410** for
  `priceType: 'session_manager'` before it reads any env var, so no new Field Manual checkout can start.
- **Retained plumbing — do not remove:** the `session_manager` row in `PRICE_CATALOG` plus the
  `STRIPE_PRICE_SESSION_MANAGER` env var (`shared/product-catalog.ts`). They let a late or in-flight
  payment resolve to `session_manager` at `/checkout/success` (which thanks the buyer and links the free
  reader) and in the webhook, instead of falling back to `contentgrade_pro` (success page) or
  `audiencedecoder_report` (webhook).
- `src/data/packages.ts` / `src/data/standalone-projects.json` — registry entries for the `/projects` grid
  and the npm-package card.

`~/Projects/Bilko/` now has its own `session-manager-operations/` root and receives cross-project reports as
`proposed` Epics via the `feedback_open_session` MCP tool (see `send-feedback`). Product-page work for
session-manager itself is still `/develop` here, not a report to Bilko.


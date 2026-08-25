# bilko.run marketing page + purchase flow

> Extracted from `CLAUDE.md` on 2026-08-24 (verbatim). Lives in the sibling repo `~/Projects/Bilko/`,
> not here. Read before touching anything about the product page, checkout, or the npm listing.

This repo ships the app only. The public marketing/purchase page at **bilko.run/products/session-manager**
(hero, feature list, "Buy Now" → Stripe Checkout, `/checkout/success` license/receipt page) and the
npm-package registry entry (`Session Manager` card on bilko.run/projects) live in a **separate sibling
repo**: `~/Projects/Bilko/` (git remote `origin` → `StanislavBG/bilko-run`, **not** `content-grade`). Bilko
is Stanislav's own multi-project *hosting platform* — the App-Store-style host for bilko.run — not a
third-party service, so issues with the product page are ours to fix, just in that repo.

Key files in `~/Projects/Bilko/` for session-manager's listing:
- `src/pages/SessionManagerPage.tsx` — the product page itself (hero Buy Now buttons scroll to `#buy`;
  the real purchase submit is in `BuySection`, which calls `startSessionManagerCheckout`).
- `src/lib/sessionManagerCheckout.ts` — POSTs `{ email, priceType: 'session_manager' }` to
  `/api/stripe/create-checkout-session`.
- `server/routes/stripe.ts` — creates the Stripe Checkout session server-side; 503s with
  `"Stripe not configured — price ID missing"` if the `STRIPE_PRICE_SESSION_MANAGER` env var isn't set
  on the Render deploy (see `shared/product-catalog.ts` catalog entry, `envVar: 'STRIPE_PRICE_SESSION_MANAGER'`).
  That env var not being set on Render is the most likely cause if "Buy Now" appears to do nothing —
  the failure surfaces only as a small inline error under the email form, easy to miss.
- `src/data/packages.ts` / `src/data/standalone-projects.json` — registry entries for the `/projects` grid
  and the npm-package card.

There is **no intake channel into `~/Projects/Bilko/`** — no feedback folder (checked 2026-07-28), and no
cross-project Epic filing (removed 2026-08-02). Report a cross-repo issue to the human, or fix it directly in
`~/Projects/Bilko/` (it's the same author's project, not an external service).


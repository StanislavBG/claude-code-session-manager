# Field Manual 2.0.1 — every chapter free

- **Released:** 2026-09-25. Documents Session Manager v0.98.0 (no app content change since
  0.97.0, which the published 2.0.0 bundle names).
- **Why:** owner decision (2026-09-25) — the Field Manual is completely free: all 13 chapters,
  the offline HTML edition and the PDF, with no buy UI anywhere. The app was already free and
  stays free (root `CLAUDE.md`, open-core law).
- **Why a new version instead of editing 2.0.0:** releases are immutable, and the Bilko server
  caches each version's manifest for the life of the process, so flipping flags inside the served
  2.0.0 folder would do nothing until a restart.

## What changed

- `manual.json`: `free: true` on all 13 chapters (2.0.0 had 4: `welcome`, `what-is-an-agent`,
  `claude-code-basics`, `glossary`); `version` 2.0.0 → 2.0.1; `releasedAt` 2026-09-25;
  `documentsAppVersion` 0.98.0, the value main set in `06e42298` (the published 2.0.0 bundle
  says 0.97.0; no documented UI changed between the two).
- `chapters/welcome.html`: the one sentence that said "only this manual is a paid product" now
  says the manual is free too. No other chapter text changed.
- Offline edition footer (`web/manual/build.mjs`): "Your copy of …" purchase wording replaced
  with "… is free, updates included".
- `web/manual/build.mjs` now refuses to build unless **every** chapter is `free: true` (was: at
  least one). Bilko's chapter route keys its lock on that flag, so a chapter added without it
  would otherwise ship locked.
- Authoring docs reworded to match: `README.md`, `STYLE.md`, the `builder` and `builder:manual`
  skills.

## Not changed

- Chapter content, slugs, titles, parts and order — identical to 2.0.0.
- Bilko's Stripe wiring (`PRICE_CATALOG` entry, `STRIPE_PRICE_SESSION_MANAGER`, checkout-success
  resolution) stays so late or in-flight payments still resolve. Past buyers keep their
  entitlement rows.
- Reader UI, download route and product-page changes live in the Bilko repo, not here.

## Build

`node web/manual/build.mjs --out ~/Projects/Bilko/data/manual/releases` emits
`data/manual/releases/2.0.1/` (13 chapters, all free, offline HTML + PDF).

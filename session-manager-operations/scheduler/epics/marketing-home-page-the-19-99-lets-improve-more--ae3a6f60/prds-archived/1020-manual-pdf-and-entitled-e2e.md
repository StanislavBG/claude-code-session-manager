---
title: Manual: PDF edition + entitled-buyer E2E coverage (cross-repo into Bilko)
cwd: /home/bilko/Projects/session-manager
estimateMinutes: 60
sourcePromptId: marketing-home-page-the-19-99-lets-improve-more--ae3a6f60
---
# Goal

Two gaps remain in the manual delivery framework. (1) The only downloadable asset today is the generated offline HTML edition; buyers expect a PDF, and the asset pipeline already supports one — it just needs generating. (2) Test coverage stops at the unauthenticated boundary: 402/401/403 and traversal guards are covered, but no test exercises the ENTITLED path end-to-end (status → paid chapter body → download-token → streamed bytes). Close both. The PDF generator belongs here in session-manager alongside the rest of the manual build; the tests belong in the sibling ~/Projects/Bilko/ repo where the routes live.

# Acceptance criteria

- [ ] scripts/build-manual.mjs also emits a PDF edition for the current release, deterministically and with no manual step; manual.json declares it as a second asset entry alongside offline-html with mime application/pdf.
- [ ] The build's existing refusal still holds: an asset declared in manual.json without a resolvable source fails the build rather than shipping a broken download button.
- [ ] `npm run manual:check` and `npm run manual:build` both succeed and the emitted bundle contains the PDF with a byte count matching its manifest entry.
- [ ] In ~/Projects/Bilko/tests/manual.test.ts, an entitled-path test stubs the purchase lookup so hasPurchased(email,'session_manager') is true, then asserts: /api/manual/status returns entitled:true with a toc; /api/manual/chapter/<paid-slug> returns 200 with a non-empty html body; POST /api/manual/download-token returns a url whose token verifies; and GET on that url streams the asset's full declared byte count with Content-Disposition attachment and Cache-Control 'private, no-store'.
- [ ] A test asserts a minted token still only unlocks the asset it names — entitlement is checked at mint time, so the token must never act as a general-purpose bearer credential for other assets or versions.
- [ ] MANUAL_DOWNLOAD_SECRET is documented as a required production env var wherever ~/Projects/Bilko documents its others, noting that without it tokens are signed with a per-process key and break across restarts and instances.
- [ ] In ~/Projects/Bilko: `npx tsc --noEmit`, `npx tsc -p tsconfig.server.json --noEmit`, and the full `npx vitest run` suite all pass.
- [ ] In ~/Projects/session-manager: `npm run typecheck` passes.
- [ ] Both repos are committed locally (two commits, one logical release). Do not push.

# Implementation notes

Cross-repo PRD — ~/Projects/Bilko/ is the same author's hosting platform, not a third-party service, so editing it directly is expected. Bilko-side files: server/routes/manual.ts (route contract), server/services/manual.ts (disk + tokens), shared/manual-catalog.ts (constants), tests/manual.test.ts (10 existing tests, all passing — extend, don't replace). Follow the stubbing style in tests/stripe-checkout-success.test.ts for the Stripe/db seams. session-manager-side: scripts/build-manual.mjs owns asset emission; session-manager-operations/manual/README.md documents the contract. For PDF generation prefer rendering the already-generated offline HTML (it inlines all its CSS) via a headless browser — Playwright is already a devDependency here, so `page.pdf()` avoids adding a dependency. Do NOT change MANUAL_PRODUCT_KEY or add a second Stripe SKU: the $19.99 session_manager purchase is the entitlement by design and every past buyer already holds it. This PRD is executed by dev-lead.

# Out of scope

- Chapter authoring (PRD 1019).
- Screenshot capture (PRD 1018).
- Any pricing, Stripe catalog, or entitlement-model change.
- Pushing either repo.

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).

---
title: Public /projects/session-manager/ marketing page gated behind Clerk sign-in
source: bilko (blog-for-project-feature showcase run, Bilko session)
type: bug
severity: high
---

# What happens / what's missing

The live, production static-path marketing page at `https://bilko.run/projects/session-manager/`
does not render the marketing/landing content for an anonymous visitor. Instead it shows a
full-page Clerk "Sign in to Bilko" modal ("Welcome back! Please sign in to continue" — Google
OAuth + username fields, "Secured by Clerk") in place of the page content, reproduced twice in a
row on fresh navigations.

Session Manager is described in its own README as "Free, MIT, zero telemetry" and is registered
in Bilko's `standalone-projects.json` as `kind: static-path`, which per Bilko's host contract
should be served directly by Fastify static and "never hit the SPA" — i.e. no Clerk/auth
involvement at all for a public marketing page. A first-time visitor or anyone trying to read
about the product currently cannot see any content without signing in to Bilko first.

# Evidence

- URL: `https://bilko.run/projects/session-manager/`
- `curl -s -L https://bilko.run/projects/session-manager/` returns 200 with `<title>Session
  Manager</title>` and a normal-looking static shell (so the raw HTML/JS asset itself is served
  correctly) — the auth gate appears only after the client-side bundle boots.
- Browser console on load (captured via Playwright) shows CSP report-only violations naming
  Clerk/Stripe script and connect sources on this page:
  - `Loading the script '.../assets/index-CGqNL6ih.js' violates ... "script-src 'self'
    'nonce-...' https://js.clerk.com https://js.stripe.com 'strict-dynamic'"`
  - `Connecting to 'https://clerk.bilko.run/v1/environment?...' violates ... "connect-src 'self'
    https://*.clerk.com https://api.stripe.com"`
  This means the CSP/response headers serving this "static" page are the same ones used for the
  authenticated app shell (Clerk + Stripe allowlisted), not a plain static-asset response — i.e.
  this page is not being served the way the static-path contract describes.
- Two screenshots taken this session (both immediately after `page.goto`, no interaction) both
  show the Clerk sign-in modal instead of any Session Manager content.

# Suggested direction (optional)

This may actually be rooted in Bilko's host response/CSP headers for this static route rather
than anything in this repo's own published bundle — worth cross-checking with whoever serves
`/projects/session-manager/` on the host side before assuming the fix lives in this repo. Either
way, flagging here per the "public static-path page should never require sign-in" expectation, so
the discrepancy is tracked from the session-manager side too. This blocked an attempt to build a
real-screenshot "Product Introduction" showcase for college students from the production page, as
requested.

## RESOLUTION

**Declined for `session-manager` — this repo has no static-path/CSP/Clerk code to change.**
Confirmed via this project's own `CLAUDE.md`: `bilko.run/projects/session-manager/` and the
Fastify static-path routing, CSP headers, and Clerk/Stripe host config that gate it all live in
the sibling repo `~/Projects/Bilko/` (git remote `StanislavBG/bilko-run`), not in this repo — this
repo ships the app only. `~/Projects/Bilko/` has no `session-manager-operations/feedback/` intake
folder yet (confirmed again this pass — `ls ~/Projects/Bilko/session-manager-operations/feedback/`
does not exist), so `/my-feedback to Bilko` cannot forward this automatically. Per this project's
own memory note on the topic: cross-repo issues about the bilko.run listing/CSP/auth should be
fixed directly in `~/Projects/Bilko/` (same author, not a third-party service) rather than routed
through a feedback channel that doesn't exist there yet. Recommend: either author a PRD directly
in `~/Projects/Bilko/session-manager-operations/scheduler/prds/` in a session cwd'd there, or
create that project's feedback intake folder so this class of report has a home going forward.

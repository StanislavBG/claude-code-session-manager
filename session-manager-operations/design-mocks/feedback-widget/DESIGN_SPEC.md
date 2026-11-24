# Feedback widget — design spec (maps the handoff onto Session Manager)

Source: Claude Design project "Overlay Feedback Widget Design" (786055bd-ab0c-4f32-9537-95ec5cea37ed),
folder `design_handoff_feedback_widget/`, imported 2026-11-23. The six files beside this one are
byte-exact copies. `README.md` is the binding UI spec (every value, state, key and copy string);
this file only says where each part lands and which handoff choices we deliberately change.
Architecture and wire contract: `session-manager-operations/architecture/site-feedback.md`.

## What lands where

| Handoff part | Lands in |
| --- | --- |
| `report.schema.json` (+ `report.example.json`) | Canonical copy `web/feedback-widget/schema/report.v1.json` (+ `report.v1.example.json`); desktop zod mirror `src/main/lib/feedback-remote/feedbackReport.cjs` |
| §1 embedding, mounting, isolation | `web/feedback-widget/src/host.ts` |
| §1 console + network buffering | `web/feedback-widget/src/buffers.ts` |
| §1 screenshot capture | `web/feedback-widget/src/capture.ts` |
| §1 submission + failure handling | `src/seal.ts`, `src/transport.ts`, `src/outbox.ts` |
| §5.4 element selector | `src/selector.ts` |
| §2 state machine, §3 keys, §4 focus | `src/ui/machine.ts`, `src/ui/keys.ts` |
| §5–§8 components, tokens, icons | `src/ui/*` (Preact inside the shadow root) |
| Receiving side | desktop drain into `<project>/session-manager-operations/feedback-inbox/` |

Build the handoff's **defaults** first (launcher `corner`, flow `annotate`, toolbar `dock`, success
`receipt`). The other variants follow as config options in a later plan.

## Decided changes to the handoff (owner-approved architecture, 2026-11-23)

1. **Endpoint.** The default destination is a sealed drop box on the bilko.run relay, derived from
   `data-key="fbk1_<boxId>.<keyFingerprint>"`. The widget fetches the box public key, checks its
   fingerprint, encrypts the handoff's exact multipart body (ECIES: P-256 ECDH, HKDF-SHA256,
   AES-256-GCM) and POSTs the ciphertext. `endpoint` stays as an option for self-hosters and then
   sends the handoff's plain multipart unchanged, `X-Feedback-Project` header included.
2. **Fonts.** Self-hosted under the widget's own bilko.run path, with the handoff's system fallbacks.
   No Google Fonts request from customers' pages (visitor privacy).
3. **Strict-CSP styling.** Styles go through `adoptedStyleSheets` and CSSOM property writes only;
   no `style` attributes and no `<style>` elements, so a host page without `'unsafe-inline'` works.
4. **Capture failure still sends.** Optional `client.captureError` (string, ≤ 200) is added to the
   schema; on failure the widget opens over the live page and sends a placeholder PNG.
5. **Top frame only, idempotent.** The widget renders only when `window.top === window`, and a
   second script tag is a no-op.
6. **Bundle path.** One IIFE at `https://bilko.run/projects/session-manager/widget/v1/feedback.js`, shipped
   inside this repo's one static bundle (bilko.run binds one slug per repo, so a separate slug was refused on
   2026-11-23). It is copied into `web/remote-app/dist/widget/v1/` at build time, and a widget release is
   published from a detached worktree at the last published phone commit plus the widget, so unreleased
   phone-remote features never ship with it.

## First live site: Three Winds (`~/Projects/3PMahjong`)

The web build is a React Native Web (Expo) DOM, so the DOM rasteriser applies. The handoff's
desktop-only rule holds: the widget does not render on touch-only devices, so the iPad app (the
primary device, native) and iPad Safari are not covered; reporters use the web build on a laptop.
Three Winds embeds the snippet behind its own `apps/app/ui/hostConfig.ts` setting (its
"every host value is a setting" rule), in its own repo, once the bundle is live.

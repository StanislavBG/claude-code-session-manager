# docs/design/ — Claude Design handoff bundles (HISTORICAL)

Part of the [`docs/`](../README.md) frozen archive — see that file's banner before
trusting anything here.

This directory holds exported handoff bundles from Claude Design
(claude.ai/design): a user mocks up a tab's UI in HTML/CSS/JS, then exports the
bundle so a coding agent can reimplement it. Two such bundles live here, plus one
standalone parked spec.

## The two bundles

| Bundle | Exported | Maps to shipped tab | Status |
| --- | --- | --- | --- |
| [`scheduler/`](scheduler/) | 2026-06-07 | Scheduler tab (`src/renderer/components/tabs/Scheduler.tsx`) | HISTORICAL — shipped |
| [`usage/`](usage/) | 2026-06-07 | Usage/History tab (`src/renderer/components/tabs/History.tsx`, `HistoryDashboard.tsx`) | HISTORICAL — shipped |

Each bundle is self-contained: its `almanac-palette.jsx` is the exported design-token
set, and `*.jsx` files alongside it are the HTML/CSS/JS prototypes. Once implemented,
the live styling lives in the app itself (Tailwind config + components), not here —
treat both bundles as frozen prototypes, not a source of truth for current tokens.

**`scheduler/almanac-palette.jsx` and `usage/almanac-palette.jsx` are byte-identical**
(md5 `6af6332792355773bd34033ba00b83cb`, 519 bytes each) — both exports carried the
same Almanac token set. Neither is more canonical than the other; the live palette is
in the app.

The former boilerplate `README.md` in each bundle directory (generic "CODING AGENTS:
READ THIS FIRST" instructions pointing at a `session-manager/chats/` transcript
directory that does not exist in this repo) has been removed — it instructed an agent
to read directories with nothing in them.

## The standalone spec

[`browser-tab.design.jsx`](browser-tab.design.jsx) (exported 2026-07-09) specs a
Browser tab that was never built — no `WebContentsView` embedding exists anywhere in
`src/`. It is parked design for a tab that was never built, not a live constraint on
any current PRD.

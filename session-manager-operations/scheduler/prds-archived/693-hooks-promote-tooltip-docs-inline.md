---
title: Hooks tab — promote hover-only event documentation to always-visible text
cwd: ~/Projects/session-manager
estimateMinutes: 15
---

# Goal

Implement the design already built and browser-verified in Claude Design (project "Session
Manager", file `Hooks - Guided.html` —
https://claude.ai/design/p/0ca33cd3-c2fa-4644-b728-bde42292abbd?file=Hooks+-+Guided.html).

`src/renderer/components/tabs/Hooks.tsx`'s sidebar (`ListDetail`'s `sidebar` prop, lines
~330-365) already has real, well-authored explanatory content per hook event — `HOOK_EVENT_DOCS[ev]`
gives a `when` sentence, a `payload` shape, and sometimes an `example` — but it only surfaces via
a `Tooltip` on hover (lines 335-348). This is the same discoverability problem just fixed for the
left-nav sidebar (`AlmanacSidebar.tsx`'s row hints, PRD 693-navshell-visible-hints-group-
descriptions): real content exists, but a first-time user has to hover-and-wait per row to find
it, across every one of the hook event types.

# Acceptance criteria

- [ ] In the sidebar row for each hook event (`Hooks.tsx:346-364`), render `doc.when` (the
  one-line description) directly under the event name as small, muted, single-line-clamped
  text — always visible, not only in the `Tooltip`. Keep the `Tooltip` itself for the fuller
  payload-shape/example detail (that's reasonable to keep as a hover affordance for a first-time
  user who wants more than the one-line summary) — this AC only promotes the top-level `when`
  sentence to always-visible, matching the verified nav-shell pattern.
  Match the visual treatment used in `AlmanacSidebar.tsx`'s row hint text (11px, muted,
  clamped) for consistency across the app rather than inventing a new text style here.
- [ ] For events with no `HOOK_EVENT_DOCS` entry (currently rendered as `<span
  className="text-fg-faint italic">no documentation yet</span>` inside the tooltip only), also
  show that "no documentation yet" note inline under the name rather than only on hover — a
  first-time user should see at a glance which events are undocumented, not discover it by
  hovering each one.
- [ ] `timeout 300 npm run typecheck` passes.
- [ ] Add/extend a test (search `find src/renderer -iname '*hooks*spec*'` first) asserting an
  event with a `HOOK_EVENT_DOCS` entry renders its `when` text inline (not just in the tooltip),
  and one without renders the "no documentation yet" note inline. Run via
  `timeout 120 npx vitest run <files touched>`.

# Implementation notes

- Read `src/renderer/components/tabs/Hooks.tsx` in full first, specifically the `HOOK_EVENT_DOCS`
  map and the sidebar row block (lines ~330-365) — this is a rendering change (show text that
  already exists), not new data.
- Don't remove the `Tooltip` — keep it for the deeper payload/example content; this PRD only
  promotes the top-level one-line summary out of hover-only territory.

# Out of scope

- Do not add `HOOK_EVENT_DOCS` entries for events that don't have one — showing "no documentation
  yet" inline is the correct behavior for those, not a reason to author new docs in this PRD.
- Do not change the detail panel (hook-group editing) — sidebar row only.

## Engineering standards

Before writing any code, read `~/Projects/session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging, API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is mandatory, especially Execution discipline (bounded commands, verify before done, the finish-protocol sentinel).

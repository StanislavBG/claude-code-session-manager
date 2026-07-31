---
title: AlmanacSidebar — always-visible per-row hints + per-group descriptions
cwd: ~/Projects/session-manager
estimateMinutes: 20
---

# Goal

Implement the design already built and browser-verified in Claude Design
(project "Session Manager", file `Nav Shell - Guided.html` —
https://claude.ai/design/p/0ca33cd3-c2fa-4644-b728-bde42292abbd?file=Nav+Shell+-+Guided.html).

`src/renderer/components/layout/AlmanacSidebar.tsx`'s `NavRow`/`ToolRow` components currently
show only an icon + label for each of the 21 left-nav destinations; the genuine one-line
explanation already stored per item (`navGroups.ts`'s `NAV_ITEMS[].hint`) only surfaces as a
native HTML `title` attribute (`AlmanacSidebar.tsx:378` and `:412`) — invisible until hover, easy
for a first-time user to never discover across 21 rows. Likewise `NavGroupHeader` renders only
the bare group name (Workspace/Configure/Tools) with no explanation of what that grouping means.

Make both always visible: each row shows its `hint` as small text under the label (not a
tooltip), and each group header shows a one-line description of what the group actually is.

# Acceptance criteria

- [ ] Add a `desc` field per group. `navGroups.ts` currently only has `NavGroupLabel` as a bare
  string union (`'Workspace' | 'Configure' | 'Tools'`) with no per-group description data — add
  a small `NAV_GROUP_DESCRIPTIONS: Record<NavGroupLabel, string>` (or equivalent) in
  `navGroups.ts` with these exact descriptions (verbatim from the verified mockup):
  - Workspace: "Where you do the work — sessions, files, and everything currently running."
  - Configure: "How Claude behaves — changes here apply to every session you start."
  - Tools: "One-off utilities — not configuration, just things you reach for sometimes."
- [ ] `AlmanacSidebar.tsx`'s `NavGroupHeader` (lines ~345-370) renders this description as a
  small (~11px), muted, max-2-line paragraph under the group label, visible whenever the group
  isn't collapsed — matching the mockup's placement (directly under the italic small-caps group
  name, above the row list).
- [ ] `NavRow` (lines ~372-406) and `ToolRow` (lines ~408-433) each render `item.hint`/`tool.hint`
  as a small (~11px), muted, single-line-clamped text directly under the label — in addition to
  keeping the existing `title={item.hint}` attribute (native tooltip stays as a redundant a11y
  fallback, doesn't need to be removed). Do this only in the non-rail (`rail === false`) layout —
  in rail (icon-only, 52px-wide) mode there's no room for label text at all today, so there's
  no room for hint text either; leave rail mode's icon-only rendering unchanged.
- [ ] Verify the sidebar's existing scroll/overflow handling (`overflow-auto` on the scrollable
  nav body, `AlmanacSidebar.tsx:188`) still works correctly with the now-taller rows (each row
  goes from one line to two) — no layout clipping, no broken active-row indicator positioning
  (the `absolute` accent bar in `NavRow`/`ToolRow` uses fixed `top`/`bottom` insets sized for the
  old single-line row height; adjust those insets if the taller row makes the bar look
  disproportionate — compare against the verified mockup's proportions).
- [ ] Confirm the persisted sidebar width (`WIDTH_MIN = 180`, `WIDTH_DEFAULT = 252`) still gives
  hint text reasonable wrapping room at the minimum width — if 180px truncates hint text too
  aggressively to read, that's fine (truncate/clamp, don't force a wider minimum), but don't let
  it overflow the row bounds.
- [ ] `timeout 300 npm run typecheck` passes.
- [ ] Add/extend a component test for `AlmanacSidebar` (search
  `find src/renderer -iname '*almanacsidebar*spec*' -o -iname '*almanacsidebar*test*'` first) or a
  snapshot/visual assertion confirming each rendered row includes both its label and its hint
  text in the DOM (non-rail mode), and that rail mode still renders icon-only. Run it via
  `timeout 120 npx vitest run <the file>`.

# Implementation notes

- Read `src/renderer/components/layout/AlmanacSidebar.tsx` in full first — this is a layout/text
  addition to existing components, not a restructure. `NAV_ITEMS`/`navGroups.ts` already has all
  the row-level hint text; only the per-group description is new data.
- The verified Claude Design mockup (link above) shows the exact visual proportions/spacing to
  match — read it for reference before choosing font sizes/margins, rather than guessing.
- Don't touch `MainPane.tsx`'s `PAGE_META`/`SectionFrame`/`LearningPanel` — that's a separate
  mechanism (per-screen intro + "Learn" panel), out of scope for this PRD, which is only about
  the sidebar's own row/group rendering.

# Out of scope

- Do not change rail (collapsed icon-only) mode's rendering.
- Do not change the sidebar's resize/collapse/localStorage-persistence mechanics.
- Do not touch any individual tab's own content (Skills, Settings, etc.) — sidebar chrome only.

## Engineering standards

Before writing any code, read `~/Projects/session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging, API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is mandatory, especially Execution discipline (bounded commands, verify before done, the finish-protocol sentinel).

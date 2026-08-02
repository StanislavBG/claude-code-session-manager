---
title: Give /develop a default design-source priority order for UI work with no brief
source: Self project (bilko), filed by Claude during a live session
type: enhancement
severity: normal
---

# What happens / what's missing

`/develop`'s skill instructions (session-manager-dev plugin, `skills/develop/SKILL.md`)
carry engineering standards (TDD, performance, API reuse) inline for the headless
executor, but have no equivalent standard for **visual design decisions** when a
PRD's UI work doesn't ship its own design brief. In practice the executor (me,
this session) reached for the bundled `dataviz` skill, pulled its reference
palette's dark-mode hex values, and shipped a dashboard with an objectively
broken dark theme — because nothing in `/develop` requires validating or even
*rendering* dark mode before calling UI work done.

Concretely, in the `/home/bilko/Self` project (`self/claude-usage/dashboard.html`,
`self/skills-inventory/dashboard.html`), the shipped dark tokens were:

```
--surface-1: #1a1a19   (panel/tile background)
--page:      #0d0d0d   (body background)
--border:    rgba(255,255,255,0.10)
```

Math (WCAG relative luminance) on those exact tokens:

- `#1a1a19` vs `#0d0d0d` → **contrast 1.12:1** — panels are visually indistinguishable
  from the page behind them.
- `rgba(255,255,255,0.10)` blended onto `#1a1a19` → **contrast ~1.34:1** against the
  surface it outlines — the only remaining separator between panels is also too
  faint to see.

The categorical chart/series colors themselves *passed* `dataviz`'s
`validate_palette.js` in both modes (I ran it — see Evidence) — the defect was
in the surrounding chrome (surface/page/border tokens), which the skill's palette
reference documents but which its own process (§7: "Render it and look at it")
would have caught immediately if actually executed for dark mode. I validated
and screenshotted light mode only; dark mode was never rendered before I called
the work done. The user caught it by eye in their own browser, not from anything
I checked.

# Evidence

- Bad tokens as shipped (now fixed in that project, not this one):
  `self/claude-usage/dashboard.html` and `self/skills-inventory/dashboard.html`
  in `/home/bilko/Self`, git history around 2026-07-21.
- Palette validator run (dataviz skill, `scripts/validate_palette.js`) confirming
  the categorical marks passed while the chrome tokens were never checked:
  ```
  node validate_palette.js "#3987e5,#c98500,#199e70,#9085e9,#d55181" --mode dark --surface "#1a1a19"
  → ALL CHECKS PASS (categorical series colors only — surface/border tokens are
    out of this validator's scope entirely)
  ```
- Contrast math for the chrome tokens (plain WCAG relative-luminance formula,
  computed live in-session, not from the validator — it doesn't check this):
  `#1a1a19` vs `#0d0d0d` = 1.12:1; `rgba(255,255,255,0.10)` blended over `#1a1a19`
  = 1.34:1.
- Fix applied (in the Self project, for reference — not something session-manager
  needs to replicate, just evidence the numbers move): surface bumped to
  `#201f1e`, border to `rgba(255,255,255,0.18)`, plus a subtle
  `box-shadow: 0 1px 0 rgba(255,255,255,.03) inset, 0 2px 10px rgba(0,0,0,.55)`
  on panels/tiles for depth. Re-screenshotted in actual `prefers-color-scheme:
  dark` (Playwright `page.emulateMedia({colorScheme:'dark'})`) and visually
  confirmed panels now read as distinct surfaces.

# Suggested direction

Add a short, explicit **design-source priority order** to `/develop`'s inline
standards (or to a shared `standards.md` block it already carries), for any PRD
whose acceptance criteria touch UI/visual output:

1. **User-supplied design** — if the PRD or the conversation that spawned it
   includes a design brief, mockup, brand palette, or explicit visual direction,
   use it verbatim. Never substitute a generic default when one is given.
2. **Existing project design system** — before reaching for any external skill,
   check the repo itself for an existing theme: CSS custom-property blocks,
   `tailwind.config.js`, a design-tokens file, a component library already in
   use. Reuse and extend what's there rather than introducing a second visual
   language into the same project.
3. **Only if neither exists**, invoke a high-quality skill rather than eyeballing
   colors from memory or hand-picking hex values:
   - `frontend-design` (official Anthropic marketplace plugin,
     `~/.claude/plugins/marketplaces/claude-plugins-official/plugins/frontend-design/`)
     for overall aesthetic direction, typography, and a deliberate token system —
     it explicitly guards against templated AI-default looks.
   - `dataviz` (bundled skill) for any chart/table/dashboard-heavy component —
     but require actually *running* its `validate_palette.js` for **both** light
     and dark against the real surface colors (not just the categorical marks —
     chrome tokens like panel/page/border contrast aren't covered by that script
     and need a manual check, as above), and require a rendered + screenshotted
     check of **both** color-scheme modes before the work is considered done.
     "I checked light mode" is not "I checked dark mode."

This closes the exact gap that caused this incident: nothing today tells the
executor to (a) look for a brief or existing theme first, or (b) actually verify
dark mode rather than assuming palette-reference hex values are safe by
construction.

## Resolution

Shipped directly as an instruction-file edit — no PRD needed. Added a new "Visual design
(UI/visual acceptance criteria)" section to
`plugins/session-manager-dev/skills/develop/standards.md` (inserted before "Execution
discipline"), codifying the exact three-tier priority order this item proposed: user-supplied
design > existing project design system > design-oriented skill as last resort, with an
explicit requirement to render + screenshot **both** light and dark modes (not just the
categorical/series palette validator) before calling UI work done. Since `standards.md` is
inlined verbatim into every PRD `/develop` emits, this reaches every future headless UI PRD
automatically — same rationale the README's own lesson gives for why a bare `SKILL.md`
authoring pass doesn't need to route through the scheduler (no build/test surface, pure
markdown).

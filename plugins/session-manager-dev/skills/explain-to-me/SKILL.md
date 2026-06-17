---
name: explain-to-me
description: >-
  Build and maintain HUMAN_LEARN/ — a human-readable, visually-rich HTML
  knowledge base at the repo root that explains how this project actually works.
  Deep-probes the codebase for a given topic/component (real file:line refs,
  real constants, real on-disk state — never invented), then writes or updates a
  clean, self-contained HTML — one combined component page (HUMAN_LEARN/index.html)
  plus a separate skill-chain map (HUMAN_LEARN/SKILL_MAP.html) for the local-dev
  workflow — with advanced CSS, flow diagrams, sticky nav, collapsible tables. Use
  whenever the user says "/explain-to-me X", "explain X to me", "explain how X
  works", "document X for me", "add X to HUMAN_LEARN", "make me a human-readable
  page for X", or "update the skill map". Keywords: explain, explain-to-me,
  human-learn, HUMAN_LEARN, skill map, document, one-pager, how does X work, visual
  explainer, knowledge base.
model: opus
---

# explain-to-me

Turn a question about this codebase ("explain how the scheduler works") into a
**clean, visually-rich HTML one-pager** in `HUMAN_LEARN/` at the repo root, and
keep that folder's index coherent as it grows. The output is for a *human*
catching up on the project — not for the model. It is the human-facing complement
to the Memory tab (which is Claude's own terse recall store).

The bar: **clean, explanatory, visually rich, self-contained** (opens directly in
a browser — no build, no external network deps). Every claim grounded in the
actual code.

**Document the CURRENT state, present-tense — never the journey.** A reader wants
to know *what the project is and how it works right now*, not how it got there.
This is a snapshot of the system as it stands today, not a changelog. So:

- **No PRD numbers, ticket ids, or commit refs** ("added in PRD 66", "schema
  bumped to v3"). State the field/behavior as it simply *is* — `panels.ticker_metrics`
  *carries* an `as_of` freshness field; don't say when or why it was added.
- **No evolution or "was X → now Y"** ("grew from 2 to 5 tools", "migrated off the
  local cache", "reborn processed"). Describe the 5 tools that exist; the prior
  count is irrelevant to someone reading today.
- **No incident/history narrative** ("the 06-10 churn incident", "the outage that
  shaped this", "the bug we fixed"). If a guard exists, describe *what it guards*
  in the present, not the failure that motivated it.
- **No migration tiers / in-flight roadmap / "gated" future work.** Document what
  is true now; a thing that's being retired is just "internal, not on the public
  surface" today.

Present-tense **design rationale is fine and useful** — *why the system is shaped
this way as it stands* (a tradeoff, a complexity bound, a boundary rule). That is
not history. The line is: explain the *standing* reason, never the *chronology*.
If you can't state it in the present tense without a date or a PRD, cut it.

## Where things live

- Repo root: `git rev-parse --show-toplevel` (fall back to cwd if not a git repo).
- Knowledge base: `<root>/HUMAN_LEARN/`. Create it if missing.
- **One combined page** — `HUMAN_LEARN/index.html`. Every component explainer is a
  `<section>` in this single file, under a sticky section-nav, ordered so the page
  reads top-to-bottom as one narrative. A new topic becomes a **new `<section>`**,
  never a new file. One navigable page that logically follows itself beats a folder
  of thin pages; do not re-introduce per-topic `.html` files.
- **The Skill Map** — `HUMAN_LEARN/SKILL_MAP.html`, a **separate, dedicated** page
  (NOT a section of index.html) that visualizes the *local-development skill chain*:
  the two intakes (interactive human prompt; agent feedback via `/process-feedback`)
  converging on `/develop`, which reads `/prd` + `standards.md`, queues onto the
  scheduler, and gates with review/verify — plus `/my-feedback` outbound. It is the
  "how I build on this project" companion to index.html's "how this project works."
  index.html links to it from the nav; it links back.

## Workflow

1. **Locate & survey.** Find the repo root + `HUMAN_LEARN/`. If `index.html`
   exists, read it to see what's already documented — you are *maintaining* a
   knowledge base, not starting fresh. If the topic already has a page/section,
   you are updating it, not duplicating it.
2. **Deep-probe the topic.** Read the real code. Gather exact `file:line`
   references, real constant names + values, and real on-disk state where it
   matters (run `ls`/`cat`/`jq` to ground claims in what actually exists). For a
   broad topic, fan out parallel `Explore` subagents over the relevant
   subsystems and collect the conclusions. **Never invent** a path, constant, or
   behavior — if you can't verify it, don't write it.
3. **Decide placement.** A component/subsystem topic → a new (or edited) `<section>`
   in `index.html`, slotted into the narrative order. The dev skill chain → it's in
   `SKILL_MAP.html`. Re-explaining an existing topic → edit that section in place,
   refresh the "generated" date. Never spin up a new per-topic `.html`.
4. **Write the HTML.** Use the design system below — both pages share the same tokens
   and components so they read as one product. A page must be self-contained (inline
   `<style>`, no external fonts/scripts/CDNs). Lead with what the thing *is* and *when
   it runs*, then the step-by-step flow with `file:line` tags, then the knobs (a
   collapsible constants table), then the present-tense design rationale ("why
   it's shaped this way" as it *stands* — a standing tradeoff/bound, never a dated
   history or a PRD).
5. **Wire the navigation.** Add/refresh the topic's pill in `index.html`'s sticky
   section-nav (and the footer's source-file list). Keep the nav and `SKILL_MAP.html`
   cross-links intact: index.html's nav has a "⛓ Skill Map ↗" link, SKILL_MAP.html's
   nav links back to "📖 HUMAN_LEARN".
6. **Maintain the Skill Map.** When the local-dev skills/commands change — a new skill
   in `~/.claude/skills/`, a changed Role/Never contract, a re-routed step in the
   chain — refresh `SKILL_MAP.html` (its chain diagram + the role-contract table +
   the two walkthroughs) so it stays a faithful map of the actual files on disk.
7. **Tell the user the path** to open (`HUMAN_LEARN/index.html` or
   `HUMAN_LEARN/SKILL_MAP.html`, optionally with a `#anchor`). Do not commit unless asked.

## Grounding rules (non-negotiable)

- Every behavioral claim cites a real `file:line`. Spot-check by reading the
  cited line before writing it.
- Constants show their real values from the source, not approximations.
- "On disk" claims are verified with a real command first.
- If two sources disagree (e.g. a stale CLAUDE.md vs the code), trust the code
  and note the discrepancy.

## Maintenance

- Idempotent: re-running for the same topic updates that `<section>` (and its nav
  pill) in place — it never appends a duplicate or spawns a new file.
- Never clobber unrelated sections. Edit the one section the topic owns.
- Refresh the footer "generated <date>" and the source-file list on each update.
- HUMAN_LEARN holds exactly two pages: `index.html` (components, one combined page)
  and `SKILL_MAP.html` (the dev skill chain). They cross-link via their navs. Don't
  add a third page.

## Design system

Reuse these tokens and patterns verbatim so every page looks like one product.
A complete, copy-ready exemplar lives at `assets/style-reference.html` next to
this file — **read it and mirror its structure/CSS** for any new page. The
essentials:

**Palette + base** (inline `<style>`, dark theme):

```css
:root{
  --bg:#0d1117; --panel:#161b22; --panel2:#1c2330; --line:#2d333b;
  --fg:#e6edf3; --dim:#9da7b3; --faint:#6e7681;
  --blue:#60a5fa; --green:#34d399; --amber:#fbbf24; --violet:#a78bfa;
  --pink:#f472b6; --red:#f87171; --cyan:#22d3ee;
  --mono:ui-monospace,'SF Mono',Menlo,Consolas,monospace;
}
*{box-sizing:border-box;margin:0;padding:0}
html{scroll-behavior:smooth}
body{background:var(--bg);color:var(--fg);
  font:15px/1.6 ui-sans-serif,system-ui,sans-serif;padding:0 20px 80px}
.wrap{max-width:980px;margin:0 auto}
code{font-family:var(--mono);font-size:12.5px;background:var(--panel2);
  border:1px solid var(--line);border-radius:4px;padding:1px 5px}
pre{font-family:var(--mono);font-size:12px;background:var(--panel);
  border:1px solid var(--line);border-radius:8px;padding:14px 16px;overflow-x:auto}
```

**Component patterns** (use the ones the topic needs — don't force all of them):

- **`.loc` chip** — a cyan monospace pill for every `file:line` reference. This is
  the signature element: claims are traceable.
  `font:11px var(--mono);color:var(--cyan);background:rgba(34,211,238,.08);
  border:1px solid rgba(34,211,238,.25);border-radius:99px;padding:1px 9px`
- **`.proc` badge** — colored uppercase pill marking *where* a step runs
  (e.g. shell hook / main process / subprocess / renderer / disk / network). One
  color per layer; show a legend once near the top.
- **Sticky section nav** — for multi-section pages: a `position:sticky;top:0`
  bar with `backdrop-filter:blur(6px)` and pill links to each `#section`.
- **Flow diagram** — a horizontal row of `.box` cards joined by `→` arrows for a
  pipeline, OR a numbered vertical "stage" stack for a deeper step-by-step. Each
  box: a title, a one-line what, and a `.where` `file:line`. Color the top border
  by the layer it runs in.
- **Stat strip** — a row of big-number cards for the load-bearing figures
  (counts, caps, sizes) pulled from real state.
- **Callout** — left-border tinted block for "the key insight" / "the caveat"
  (`.ok` green, `.bad` red, default amber).
- **Collapsible constants table** — `<details><summary>` wrapping a table of
  `constant · value · file:line · what it bounds`. Keeps the page scannable.
- **Two-column rationale** — a `grid-template-columns:1fr 1fr` "why it's shaped
  this way" section, collapsing to one column under `@media(max-width:760px)`.
- **Footer** — muted, lists the exact source files the page was distilled from +
  "generated <date>".

**Advanced techniques to deploy** (tasteful, not gratuitous): CSS grid layouts,
`position:sticky` nav, `scroll-behavior:smooth` + anchor links, `backdrop-filter`,
`<details>`/`<summary>` for progressive disclosure, responsive `@media`
breakpoints, CSS-only flow diagrams (borders + flex, no images), subtle
`transition`/`:hover` affordances on cards. **No** external fonts, scripts, CDNs,
or build step — every page is one self-contained `.html` file.

## What good looks like

Lead with the outcome (what the thing *is*, when it runs). Make the flow the
centerpiece. Tag everything with `file:line`. Surface the real numbers. Give the
present-tense design rationale where it helps (the *standing* tradeoff or
constraint that makes the shape make sense) — but **no chronology**: no PRD
numbers, no "was X → now Y", no incident/migration history, no roadmap. A reader
should learn what the project *is* today, not how it got here. Keep prose tight
and in complete sentences — visually rich, not noisy.

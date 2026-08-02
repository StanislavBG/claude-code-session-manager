# Project Pages pipeline — architecture spec

Canonical design for the "Project Page" feature: Project Home generates 3
static HTML pages per project (Marketing Landing, Feature Description,
Architecture Overview) from a fixed component library. This is the single
source of truth both the `project-home-builder` local agent
(`.claude/agents/project-home-builder.md`) and the `project-home-builder`
Epic tag's grounding prompt (`src/renderer/lib/agentTagDefs.ts`) point at —
edit here, not in either of those, when the design changes.

## Inputs (as specified by the human, 2026-08-01)

1. **Component Library** — fixed, ships with the app. Source design saved at
   `session-manager-operations/design-mocks/project-pages-component-library/`
   (read its `README.md` first). Shape: 3 lenses (`marketing` / `feature` /
   `architecture`), each a stack of **slots**, each slot 3-4 **variant**
   components, each lens shipping 3 named **presets** (fixed slot→variant
   picks) plus a "custom" override state.
2. **Project summary** — a JSON computed per project (see schema below).
3. **Summary → component mapping** — picks the best-fitting variant per slot
   (and/or a whole preset) from the summary's content, then renders.

## Non-negotiables from the human's instructions

- Output **MUST be static HTML** — 3 files, one per lens. Project Home does
  not recompose the pages live in its own React tree; it hosts pre-rendered
  HTML. This is what "guaranteed to render" means: the generated artifact is
  immune to the app's own React/Tailwind version ever drifting under it.
- Before the first run, Project Home shows an **empty state** with a
  **"Generate Now"** button — no placeholder/fake content ever.
- Generation is not a bare function call — it runs as an Epic of a
  **new type, `project-home-builder`**, so grounding, objective and output
  are pinned before the agent starts (see "Epic tag" below), the same way
  every other unit of work in this app is an Epic (CLAUDE.md's TAB/EPIC
  domain model).
- The agent doing the generation is a **registered local agent**
  (`.claude/agents/project-home-builder.md`), not an ad hoc prompt.
- Never fabricate content. Every field in the summary must trace to
  something concrete (an Epic goal, a file/dir, a CLAUDE.md convention, a
  git log entry) — same rule already enforced for `project-brief`.

## Stage 0 — Component Library (build-time asset, already captured)

Port `design-mocks/project-pages-component-library/source/*.jsx` into real
`.tsx` under `src/renderer/lib/projectPages/library/` (or a sibling location
a PRD should decide precisely). Precompile with esbuild into a pure
function:

```ts
renderProjectPages(summary: ProjectPageSummary, picks: ProjectPagePicks)
  => { marketing: string; feature: string; architecture: string }
```

Each string is a **fully self-contained HTML document** — inline CSS, fonts
self-hosted as local assets bundled with the app (never fetched from Google
Fonts at generation time — this is the same "no network egress" principle
the design library's own `PROJ.arch.principles` already states). No runtime
JSX transform, no CDN script tags, no in-browser Babel (the source bundle
uses browser-side Babel for its own live-preview tool; that is NOT the
shipped renderer).

## Stage 1 — Project Summary (`ProjectPageSummary`, computed per project)

New schema, a strict superset of the existing `ProjectBrief`
(`session-manager-operations/project-brief/`, `purpose/what/areas/scope/
conventions` only). Build incrementally on top of an already-generated
Brief rather than re-reading the repo from scratch:

- `identity`: name, tagline, oneLine, claim, sub, install command — derived
  from `package.json` + Brief's `purpose`.
- `stats[]`, `pillars[]` — derived from Brief's `areas` (file counts, heat,
  notes become pillar copy).
- `feature` (ONE deep-dive) — derived from the most-active open Epic
  (highest `heat`/most recent scope entries): name, problem/solution framed
  from that Epic's goal + its scope-timeline entries, steps from its PRD
  chain if one exists.
- `architecture` — layers/modules from Brief's `areas` + their `epic`
  ownership; decisions from Brief's `scope` entries tagged `decided`; risks
  are the one field with no clean Brief source — leave empty rather than
  invent, or optionally source from open `discussion`-tagged Epics.
- `quotes[]` — **do not fabricate testimonials**. Either omit entirely
  (proof-strip variants that need a quote simply aren't selectable) or wire
  a future opt-in source (e.g. GitHub issue comments) — out of scope for v1.

Written to `session-manager-operations/project-pages/summary.json`.

**Correction vs. an earlier draft of this spec:** this is NOT a
`projectBrief.refresh`-style main-process-orchestrated `claude -p` spawn.
Per the human's explicit instruction, generation runs as a
`project-home-builder`-tagged **Epic** — an ordinary Chat/Terminal claude
session grounded by that tag's `initialPromptTemplate` (`agentTagDefs.ts`)
and `.claude/agents/project-home-builder.md`'s protocol. That session reads
`brief.json` and the repo directly (Read/Grep/Bash tools) and composes
`summary.json` itself, then writes it with its own Write tool. There is no
separate nested `claude -p` call and no new main-process IPC for synthesis.
Cost-gating is inherent: it only runs when a human clicks "Generate Now"
(which creates/resumes the Epic), same discipline as any other Epic.

## Stage 2 — Summary → component mapping (selection)

Formalize each variant's prose `note` (already in the saved library, e.g.
"Needs a real quote.", "Needs a strong screenshot.") into a structured,
machine-checkable predicate on the variant: `requires: string[]` /
`avoidIf: string[]`, evaluated as dot-path truthiness/length checks against
the summary (e.g. `requires: ['quotes.length>0']`). A deterministic scorer
picks the highest-scoring variant per slot; ties fall back to preset `v1`
(the safest, most type-led option in every lens per the library's own
naming). No LLM call needed for v1 of this stage — nondeterministic re-
layout on every regenerate is worse than a boring, repeatable rule. An LLM
taste-pass is a plausible v2, not required to ship.

Output persisted to `session-manager-operations/project-pages/picks.json`
— idempotent regenerate: if a user has hand-picked a slot, don't silently
overwrite it (mirrors `project-brief`'s per-block `pins`, but per-slot-pick
here instead of per-paragraph-text).

## Stage 3 — Render

`renderProjectPages(summary, picks)` → 3 HTML strings. Write to
`session-manager-operations/project-pages/output/{marketing,feature,
architecture}.html` plus a `manifest.json` (`generatedAt`, `model`,
`summarySynthesizedAt`, and a drift flag vs. the Brief's own
`synthesizedAt` — same drift-chip idea `project-brief` already uses).

## Stage 4 — Project Home display

- **Empty state** (no `output/*.html` yet): centered explainer + **Generate
  Now** button — same visual pattern as today's "no brief yet" state in
  `ProjectHome.tsx`.
- **Generate Now** click creates (or resumes) an Epic tagged
  `project-home-builder` in the active project and sends it the tag's
  grounding prompt (see Epic tag below) as the opening message — the Epic
  IS the unit of work, same as every other Epic in this app.
- Once `output/*.html` exists, Project Home renders the 3 pages via a
  sandboxed `<iframe sandbox="allow-same-origin" srcDoc={html} />`, toggled
  by lens (Marketing / Feature / Architecture) — never re-parsed into the
  app's own React tree. A **Regenerate** button re-runs Stages 1-3 (same
  cost-gated UX as Brief refresh).

## Storage / ownership

**Correction vs. an earlier draft:** `project-pages/` is **NOT** an
`OWNERS` namespace. `OWNERS`'s `assertOpsWrite` fail-closed check
(`src/main/lib/opsOwnership.cjs`) only guards `config.cjs`'s own write
helpers plus two raw-`fs` main-process modules — it has no way to intercept
a claude session's own `Write` tool calls, and per the corrected Stage 1
above, that's exactly how `summary.json`/`picks.json`/`output/*.html` get
written (by the `project-home-builder` Epic's session, not by main-process
code going through `config.cjs`). This makes `project-pages/` the same
class as `design-mocks/`/`HUMAN_LEARN/` — **agent-authored artifact
output**, single author per invocation, no app-enforceable concurrent-write
hazard — not the same class as `brief.json` (main-process-orchestrated,
enforceable). Do **not** add a `project-pages` entry to `OWNERS`.

The concurrency concern is real but bounded a different way: "Generate Now"
must check for an already-active `project-home-builder` Epic for this
project and **resume/focus it** instead of creating a second one — the same
"refuse a live session" guard pattern `deleteEpic` already uses elsewhere —
rather than relying on filesystem-level write arbitration.

Add `session-manager-operations/project-pages/README.md` once the first
file lands, documenting the shape (matching `design-mocks/`'s and
`HUMAN_LEARN/`'s own READMEs, not an `OWNERS` namespace README).

## Epic tag: `project-home-builder`

Added to `src/renderer/lib/tagLibrary.ts` (`EpicTag` union + `TAG_LIBRARY`
entry) and `src/renderer/lib/agentTagDefs.ts` (`AGENT_TAG_DEFS` entry with
an `initialPromptTemplate` that grounds the session: read this spec, read
the saved component library, follow `.claude/agents/project-home-builder.md`
as the operating protocol, and the output contract (the exact file paths
under `session-manager-operations/project-pages/`). Deliberately **not**
added to `AGENT_TAG_DEFS`'s `AGENT_TAG_ORDER` yet — same precedent as the
existing `build` tag ("no UI surface to create a build-tagged Epic exists
yet"): the creation surface (the Generate Now button) is itself one of the
PRDs building this feature, so it adds the tag to `AGENT_TAG_ORDER` at the
same time it wires the button, rather than exposing a half-built creation
path in the New Epic composer before Generate Now exists.

## Screenshots

Several variants need real app screenshots (`FvShot` placeholders in the
saved library). Reuse the existing `blog-for-project-feature` skill's real-
capture pipeline rather than building a second one — out of scope for the
first PRD chain; ship with the honest placeholder pattern until wired.

## Explicit non-goals for v1

- No LLM-driven variant selection (Stage 2 is rule-based only).
- No installable "design pack" packaging (Stage 0 ships baked into the app;
  making it swappable is a later roadmap item, not part of this build).
- No automatic/background regeneration — manual trigger only, same
  cost-discipline as `project-brief`.

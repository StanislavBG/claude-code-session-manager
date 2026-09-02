# Project Pages pipeline — architecture spec

Canonical design for the "Project Page" feature: Project Home generates 5
static HTML pages per project (**Home**, Marketing Landing, Feature
Description, Architecture Overview, **Brief**) from a fixed component
library, plus a never-generated "About these templates" view explaining the
five lenses and where to hand-edit them. This is the design source of truth
for the four `project_home_*` MCP tools (`project_home_get_contract`,
`project_home_validate_summary`, `project_home_render`, `project_home_status`,
served over the app's admin routes, PRD 1089) that actually drive a
`project-home-builder` Epic's session — edit here, not in the tool
implementations, when the design changes.

**Correction, PRD "project-home-portable-persona":** generation is no longer
grounded by pointing a session at this file (or any other repo-relative
path) directly. This spec stopped being something a builder Epic reads —
neither the seeded `project-home-builder` persona
(`src/seed/agents/project-home-builder.md`, delivered to
`~/.claude/agents/`) nor the `project-home-builder` Epic tag's grounding
prompt (`src/renderer/lib/agentTagDefs.ts`) names a repo path anymore, because
a builder Epic can run against a project that never had this repo checked
out (the npm-installed case). Instead, both now point a session at the
`project_home_get_contract` MCP tool as the FIRST call of the run — its
response is a fully self-contained protocol + schema + catalog payload
computed from this spec (see "Epic tag" below). This file remains the
design source of truth for whoever implements or changes the MCP tools
themselves; it is no longer read at generation time by the builder Epic.
session-manager's own repo keeps a lean project-local overlay,
`.claude/agents/project-home-builder.md`, that adds only session-manager-
specific historical context (the saved design-mock library) on top of the
seeded persona's real protocol — see that file.

**Correction, 2026-08-02:** the original spec shipped 3 lenses
(marketing/feature/architecture) only, with Project Home's own live Brief
dashboard staying a separate, hand-built React view above the generated
block. The human then asked for the Brief's own content to be available as a
4th generated template too ("Home") — same component-library/summary/picks
pipeline as the other three, reusing `identity`/`stats`/`pillars` (already
in `ProjectPageSummary`, no schema change needed) rather than the live
Epic-queue data the React Brief shows (that stays live-only; a static page
can't show "what's running right now" truthfully). The live Brief dashboard
above the Project Pages block is unchanged and still the primary live view —
Home is an *additional* static snapshot, not a replacement for it.

**Correction, 2026-08-03 (Epic "Project Home Layout"):** the 2026-08-02
correction above is now itself superseded. Project Home is no longer a
hand-built React page with a Project Pages viewer embedded at the bottom —
its primary content area IS the generated `home` document, hosted at a fixed
path, with a shipped default so a brand-new project is never empty. The
live Brief dashboard's synthesized fields (purpose/what/areas/scope/
conventions) become their own 5th generated lens, `brief`, rather than a
separate hand-built React block stack — see "Project Home is a hosted
document, not a React page" below for the full design, and Stage 4 for how
the display changes. `PhNow`/`PhOpenQuestions` (live Epic-queue and
open-question state) are the one part of the old React page that stays
live React, per the same "a static page can't show what's running right now
truthfully" reasoning the 2026-08-02 correction already established for
Epic-queue data.

## Project Home is a hosted document, not a React page

- Project Home's main content area renders a generated, self-contained
  static HTML document, displayed via the same sandboxed
  `<iframe sandbox="allow-same-origin" srcDoc={html} />` mechanism Stage 4
  already uses for the other lenses — Project Home does not recompose this
  content live in its own React tree.
- That document lives at a **fixed path**,
  `session-manager-operations/project-pages/output/home.html` — this is what
  the app always reads for Project Home's main view, regardless of whether
  it was just generated or is days old.
- Session-manager **ships a default `home.html`** baked into the app build
  (not per-project state — see "Storage / ownership" below). A brand-new
  project with no generated output still renders a real page, never an
  empty state.
- The only way that document is replaced is the **"Generate My Project
  Home"** action, which creates (or resumes) an Epic tagged
  `project-home-builder`, bound to the `project-home-builder` agent — reusing
  the exact Epic-creation mechanism `ProjectPagesSection.tsx`'s
  `findActiveBuilderEpic` + `composeEpicIntake` already implement for
  "Generate Now" today (see Stage 4). Never an inline function call, never a
  main-process `claude -p` spawn — same non-negotiable Stage 1 already
  states for `summary.json`.

## Inputs (as specified by the human, 2026-08-01, extended 2026-08-02, 2026-08-03)

1. **Component Library** — fixed, ships with the app. Source design for the
   original 3 lenses saved at
   `session-manager-operations/design-mocks/project-pages-component-library/`
   (read its `README.md` first) — the `home` lens has no saved design mock;
   it was authored directly in
   `src/renderer/lib/projectPages/library/homeSlots.tsx` reusing the same
   `PageLensDef` shape and the marketing lens's `identity`/`stats`/`pillars`
   fields, styled as an internal dashboard rather than an outward pitch. The
   `brief` lens likewise has no saved design mock — it is authored directly
   against `ProjectBrief`'s own fields (see "Stage 1" below for the exact
   source-field mapping), styled as a straightforward read of what the
   project is, what it does, and its conventions, rather than a pitch or a
   dashboard.
   Shape: 5 lenses (`home` / `marketing` / `feature` / `architecture` /
   `brief`), each a stack of **slots**, each slot 2-4 **variant** components,
   each lens shipping named **presets** (fixed slot→variant picks) plus a
   "custom" override state.
2. **Project summary** — a JSON computed per project (see schema below).
3. **Summary → component mapping** — picks the best-fitting variant per slot
   (and/or a whole preset) from the summary's content, then renders.

## Non-negotiables from the human's instructions

- Output **MUST be static HTML** — 5 files, one per lens. Project Home does
  not recompose the pages live in its own React tree; it hosts pre-rendered
  HTML. This is what "guaranteed to render" means: the generated artifact is
  immune to the app's own React/Tailwind version ever drifting under it.
- Before the first "Generate My Project Home" run, Project Home renders the
  **shipped default `home.html`** (see "Project Home is a hosted document,
  not a React page" above) — no placeholder/fake content ever, and no
  fabricated per-project claims in the default either (see Stage 4's
  "Shipped default" subsection).
- Generation is not a bare function call — it runs as an Epic of a
  **new type, `project-home-builder`**, so grounding, objective and output
  are pinned before the agent starts (see "Epic tag" below), the same way
  every other unit of work in this app is an Epic (CLAUDE.md's TAB/EPIC
  domain model).
- The agent doing the generation is a **registered local agent**
  (`.claude/agents/project-home-builder.md`), not an ad hoc prompt.
- Never fabricate content. Every field in the summary must trace to
  something concrete (an Epic goal, a file/dir, a CLAUDE.md convention, a
  git log entry) — same rule already enforced for `project-brief`, and now
  also the rule governing the shipped default `home.html`'s copy.

## Stage 0 — Component Library (build-time asset, already captured)

Port `design-mocks/project-pages-component-library/source/*.jsx` into real
`.tsx` under `src/renderer/lib/projectPages/library/` (or a sibling location
a PRD should decide precisely). Precompile with esbuild into a pure
function:

```ts
renderProjectPages(summary: ProjectPageSummary, picks: ProjectPagePicks)
  => { home: string; marketing: string; feature: string; architecture: string; brief: string }
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
- `brief` — the `brief` lens's source fields, read directly off
  `ProjectBrief` (`session-manager-operations/project-brief/brief.json`)
  with no reshaping: `purpose` (string), `what[]`, `areas[]`, `scope[]`,
  `conventions[]`. This is the generated form of what the live React Brief
  used to render by hand (`PhWhat`/`PhAreas`/`PhScope`/`PhConventions`) —
  the `brief` lens's slots map one-to-one to these four array fields plus
  the `purpose` string; a later PRD implementing the lens should not need to
  invent any additional source data. `brief.json`'s `pins` (per-block
  edit-pins) still apply at the Brief-authoring layer (Stage 1, before this
  mapping) — the `brief` lens renders whatever `brief.json` currently holds,
  pinned or not, same as every other summary field here.
- `quotes[]` — **do not fabricate testimonials**. Either omit entirely
  (proof-strip variants that need a quote simply aren't selectable) or wire
  a future opt-in source (e.g. GitHub issue comments) — out of scope for v1.

Written to `session-manager-operations/project-pages/summary.json`.

**Correction vs. an earlier draft of this spec:** this is NOT a
`projectBrief.refresh`-style main-process-orchestrated `claude -p` spawn.
Per the human's explicit instruction, generation runs as a
`project-home-builder`-tagged **Epic** — an ordinary Chat/Terminal claude
session grounded by that tag's `initialPromptTemplate` (`agentTagDefs.ts`),
which drives the session to call the `project_home_get_contract` MCP tool
first and follow the protocol it returns (see the correction note at the top
of this file). That session reads `brief.json` and the repo directly
(Read/Grep/Bash tools) and composes `summary.json` itself, then writes it
via `project_home_render` (not a raw Write-tool file write — see Stage 3).
There is no separate nested `claude -p` call and no new main-process IPC for
synthesis beyond the four `project_home_*` admin-routed tools themselves.
Cost-gating is inherent: it only runs when a human clicks **"Generate My
Project Home"** (which creates/resumes the Epic), same discipline as any
other Epic. `brief.json` itself is still produced by
`projectBrief.refresh`'s existing main-process-orchestrated mechanism — that
mechanism is unchanged and stays, because `brief.json` remains an *input* to
Stage 1, read by the `project-home-builder` Epic session same as any other
repo file. What changes is only that `projectBrief.refresh` no longer has
its own dedicated user-facing button — see Stage 4's "One action, not two"
subsection.

## Stage 2 — Summary → component mapping (selection)

**Reversed 2026-08-03 (Epic "Project Home Layout"): there is no separate
deterministic selection stage.** The `project-home-builder` agent itself
picks each slot's variant, by reasoning over its composed summary against
the component library's own variant notes — the same class of step as
Stage 1's summary authoring, not a distinct machine-checkable predicate
scorer. Concretely: for each lens, for each slot, the agent reads the
candidate variants' prose `note`/description — served to it directly in
`project_home_get_contract`'s catalog response, sourced server-side from
`src/renderer/lib/projectPages/library/*.tsx` so the agent never needs to
read that source itself (e.g. "Needs a real quote.", "Needs a strong
screenshot.") — and judges which variant genuinely fits this project's
summary content, then passes the resulting picks to `project_home_render` —
no intermediate predicate language, no scorer script.

Output persisted to `session-manager-operations/project-pages/picks.json`
in the same shape as before (`Record<lensId, Record<slotId, variantId>>`),
plus a top-level `schemaVersion` field (see "Stale-picks migration" below).
**The 'respect existing hand-picks unless explicit start-over' rule is
unchanged and still what keeps selection stable across regenerates**: a
project's picks are judged once (or on an explicit reset request) and then
persisted like `project-brief`'s pinned blocks, so moving selection from a
script to agent judgment does not reintroduce per-regenerate
nondeterminism — the agent must not silently overwrite it (mirrors
`project-brief`'s per-block `pins`, but per-slot-pick here instead of
per-paragraph-text).

**Stale-picks migration (found 2026-08-03).** Today's on-disk
`picks.json` was written by the now-deleted deterministic scorer
(`selectionPredicates.ts`, retired by PRD 958) — every existing project's
picks are preset-`v1` defaults, not real judgment. The 'preserve existing
hand-picks on regenerate' rule above would otherwise grandfather these in
forever, silently defeating agent-owned selection for every project that
already has a `picks.json`. Decided: `picks.json` carries
`schemaVersion: 1` for scorer-era files (files with no `schemaVersion`
field at all are treated as `schemaVersion: 1` — the scorer never wrote
one) and `schemaVersion: 2` once written by the agent or hand-edited by a
human. On the first `project-home-builder` Epic run after this change, the
agent checks `picks.json`'s `schemaVersion`: if `1` (or absent), the
existing picks are **non-authoritative** — the agent re-judges every slot
from scratch (ignoring the stale values, not merging with them) and writes
the result back as `schemaVersion: 2`. Every later run treats a
`schemaVersion: 2` file as real hand/agent judgment and follows the normal
'preserve unless explicit start-over' rule. This re-judgment happens
exactly once per project, not on every run — `schemaVersion` is the marker
that prevents repeating it.

## Stage 3 — Render

`renderProjectPages(summary, picks)` → 5 HTML strings. Write to
`session-manager-operations/project-pages/output/{home,marketing,feature,
architecture,brief}.html` plus a `manifest.json` (`generatedAt`, `model`,
`summarySynthesizedAt`, and a drift flag vs. the Brief's own
`synthesizedAt` — same drift-chip idea `project-brief` already uses).
`output/home.html` is the fixed path Project Home's main view reads (see
"Project Home is a hosted document, not a React page" above) — it is
written by this same single render pass as the other four lenses, not by a
separate mechanism.

## Stage 4 — Project Home display

- **No empty state for the main view.** With a shipped default `home.html`
  (see "Project Home is a hosted document, not a React page" above), Project
  Home's main content area always has something real to show — either the
  shipped default or a project-generated document. What the UI must surface
  instead is **provenance**: a chip stating whether the currently-displayed
  `home.html` is the shipped default or a generated document, and if
  generated, when (`manifest.json`'s `generatedAt`). The **"Generate My
  Project Home"** action is always available regardless of which state is
  showing.
- **Shipped default `home.html`** is a **build-time asset**, not per-project
  state — it ships baked into the app bundle (same "ships with the app"
  status as the component library in Stage 0), not written into any
  project's `session-manager-operations/`. It must be honest about being a
  default: its copy describes what Project Home is in general and prompts
  the reader to press "Generate My Project Home" — it must **not** contain
  fabricated project-specific content (name, stats, claims about this
  particular repo), per this spec's existing never-fabricate rule. The app
  falls back to this shipped asset whenever a project's own
  `output/home.html` is absent; once a project has generated its own, that
  file (at the fixed per-project path) takes over and the shipped default is
  never shown again for that project.
- **"Generate My Project Home"** click creates (or resumes) an Epic tagged
  `project-home-builder` in the active project and sends it the tag's
  grounding prompt (see Epic tag below) as the opening message — the Epic
  IS the unit of work, same as every other Epic in this app. This reuses
  the exact mechanism `ProjectPagesSection.tsx`'s `findActiveBuilderEpic` +
  `composeEpicIntake` already implement today (there under the "Generate
  Now"/"Regenerate" names) — no new Epic-creation code path, only a rename
  and a widened trigger surface (see "One action, not two" below).
- **One action, not two.** Today there are two competing CTAs: "Refresh
  brief" (regenerates `brief.json` for the old hand-built React blocks) and
  "Generate Now"/"Regenerate" (regenerates the Project Pages HTML). These
  **consolidate into the single "Generate My Project Home" action**, because
  the Brief's content is now one of the five generated lenses (`brief`) —
  there is no longer a separate live-React consumer of `brief.json` that
  needs its own refresh trigger. `brief.json` itself, and the
  `projectBrief.refresh` mechanism that writes it, are unchanged and still
  needed — `brief.json` is still an *input* to Stage 1 (see Stage 1's
  correction note above) — it simply stops being exposed as its own
  user-facing button. "Generate My Project Home" is responsible for
  ensuring `brief.json` is fresh enough before it runs Stages 1-3 (e.g.
  invoking `projectBrief.refresh` itself as a first step, or the
  `project-home-builder` agent reading `brief.json` and refreshing it
  in-session if stale) — the exact mechanics of that call are an
  implementation detail for the PRD that wires the button, not specified
  further here.
- Once a project has generated its own `output/*.html`, Project Home renders
  the 5 pages via a sandboxed
  `<iframe sandbox="allow-same-origin" srcDoc={html} />`, toggled by lens
  (Home / Marketing / Feature / Architecture / Brief) — never re-parsed into
  the app's own React tree. The main Project Home view defaults to the
  `home` lens; the other four remain reachable the same way
  `ProjectPagesSection.tsx` exposes them today.
- **`PhNow` and `PhOpenQuestions` stay live React**, rendered as a thin strip
  **above** the hosted HTML document (default or generated) rather than
  folded into any generated lens. Reason: they show live state — "what is
  in flight" (the live Epic queue) and "waiting on you" (live unresolved
  questions) — and injecting live data into a generated static document
  would violate this spec's own non-negotiable that the generated artifact
  is "self-contained static HTML, immune to the app's own React/Tailwind
  drift" (see "Non-negotiables" above): a document that embeds live data
  stops being self-contained the moment that data changes underneath it.
  This is the same reasoning the 2026-08-02 correction already applied to
  the old React Brief's Epic-queue data — carried forward unchanged, just
  now scoped to two specific components instead of the whole page.
- A 6th tab, **"About these templates,"** is always reachable (even before
  the first "Generate My Project Home") and is never part of
  `output/*.html` — it's static explainer copy
  (`ProjectPagesLibraryExplainer` in `ProjectPagesSection.tsx`) naming the 5
  lenses, their source slot files, and the 3 real on-disk paths a human
  would touch to change what gets generated:
  `project-pages/summary.json` (the computed inputs), `project-pages/
  picks.json` (per-project, per-slot overrides — hand-edit a pick here and
  regenerating preserves it, since the `project-home-builder` agent respects
  existing picks unless explicitly told to start over, same rule Stage 2
  already had — see Stage 2's schema-version note for the one-time
  exception), and `src/renderer/lib/projectPages/library/` (the component
  library itself, shared across every project — editing it is a code
  change, not a per-project override).

## Storage / ownership

**Correction, PRD 1089/1090 (`project_home_*` MCP tools):** the write path
described in an earlier draft of this section — a builder Epic's own `Write`
tool writing `summary.json`/`picks.json`/`output/*.html` directly, with no
`OWNERS` entry needed because no main-process code was involved — is
superseded. `project_home_render` now writes those files via the app's
admin API, which IS main-process code going through `config.cjs`'s write
helpers. `project-pages` is therefore now listed in `OWNERS`
(`src/main/lib/opsOwnership.cjs`), owned by `project-home`, scoped to the
app's admin render route only (per CLAUDE.md's domain-model law) — see
`project-pages/README.md` for the exact split. A builder Epic's own direct
Write-tool authoring of anything under `project-pages/` (as opposed to going
through `project_home_render`) stays ungoverned/unsupported; the sanctioned
path for a builder Epic is always the MCP tool, never a raw file write.

The concurrency concern is real but bounded a different way: "Generate My
Project Home" must check for an already-active `project-home-builder` Epic
for this project and **resume/focus it** instead of creating a second one —
the same "refuse a live session" guard pattern `deleteEpic` already uses
elsewhere — rather than relying on filesystem-level write arbitration.

The **shipped default `home.html`** is a different storage class again: it
is packaged with the app build itself (e.g. under the renderer's own static
assets, resolved at runtime the same way other build-time-baked assets are)
— it is never written to, or read from, any project's
`session-manager-operations/` tree, and carries no per-project state at all.
It is not part of `project-pages/` and is not a candidate for an `OWNERS`
entry.

Add `session-manager-operations/project-pages/README.md` once the first
file lands, documenting the shape (matching `design-mocks/`'s and
`HUMAN_LEARN/`'s own READMEs, not an `OWNERS` namespace README).

## Epic tag: `project-home-builder`

Added to `src/renderer/lib/tagLibrary.ts` (`EpicTag` union + `TAG_LIBRARY`
entry) and `src/renderer/lib/agentTagDefs.ts` (`AGENT_TAG_DEFS` entry with
an `initialPromptTemplate` that grounds the session): call
`project_home_get_contract` first — its response IS the protocol, the
schemas, and the catalog, entirely self-contained — then follow it through
`project_home_validate_summary` → `project_home_render` →
`project_home_status`. The template names no repo-relative path (this is
what makes generation work on a machine with only the npm package
installed) and explicitly instructs the session to report and stop, never
build pipeline infrastructure, if the contract tool is unavailable or
errors. Deliberately **not**
added to `AGENT_TAG_DEFS`'s `AGENT_TAG_ORDER` yet — same precedent as the
existing `build` tag ("no UI surface to create a build-tagged Epic exists
yet"): the creation surface (the "Generate My Project Home" button) is
itself one of the PRDs building this feature, so it adds the tag to
`AGENT_TAG_ORDER` at the same time it wires the button, rather than exposing
a half-built creation path in the New Epic composer before that button
exists.

## Screenshots

Several variants need real app screenshots (`FvShot` placeholders in the
saved library). Reuse the existing `blog-for-project-feature` skill's real-
capture pipeline rather than building a second one — out of scope for the
first PRD chain; ship with the honest placeholder pattern until wired.

## Explicit non-goals for v1

- No installable "design pack" packaging (Stage 0 ships baked into the app;
  making it swappable is a later roadmap item, not part of this build).
- No automatic/background regeneration — manual trigger only, same
  cost-discipline as `project-brief`.

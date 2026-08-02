# Project Pages — Component Library (design source)

Source for the "Project Page" template gallery concept: three lenses on one
project (Marketing Landing / Feature Description / Architecture Overview),
each a stack of **slots**, each slot with **3-4 interchangeable component
variants**, each page shipping **3 named presets** (fixed slot→variant picks)
plus a "custom" state when a user overrides one slot by hand.

`Component-Library.bundle.html` is the original self-extracting preview
(open directly in a browser — it unpacks its own React/Babel/font assets, no
network needed). `source/` is that same design **decompressed into readable
JSX** for reference when porting this into the real app — the bundle embeds
each file gzip+base64'd inside a `<script type="__bundler/manifest">` JSON
blob; nothing in `source/` is hand-written, it's an extraction.

## Files (load order matters — later files splice into earlier ones' globals)

| File | Defines |
| --- | --- |
| `00-kit-and-project-summary-shape.jsx` | `PK` (design tokens), `PROJ` (the **project summary JSON shape** — see below), and shared primitives (`PkSection`, `PkH`, `PkBody`, `PkPill`, `PkShot`, `PkCmd`, `PkBtn`, …) |
| `10-marketing-slots-core.jsx` | Marketing hero/proof/pillars/close slot variants + `window.PAGE_MARKETING` (slots + 3 presets) |
| `11-marketing-slots-depth.jsx` | Splices 4 more marketing slots (tour/workflow/depth/faq) into `PAGE_MARKETING` via an IIFE — the "product-depth" section between pillars and the close |
| `20-feature-slots-core.jsx` | Feature header/mechanism/rules/status slot variants + `window.PAGE_FEATURE` (slots + 3 presets) |
| `21-feature-slots-visual.jsx` | Visual-first feature slots (screenshot walkthroughs, app-window chrome) |
| `30-architecture-slots.jsx` | Architecture summary/map/flow/decisions slot variants + `window.PAGE_ARCH` (slots + 3 presets) |
| `40-shell.jsx` | `ProjectPages` — the gallery shell: lens tabs, preset chips, a "Component library" browse mode (`PpLibrary`), and the live composed-page preview. This is a **design-tool UI for picking**, not the shipped renderer. |

## The project summary shape (`PROJ` in `00-...jsx`)

One JSON object per project, "every token the agent fills in": `name`,
`tag`, `version`, `oneLine`, `claim`, `sub`, `audience`, `install`, `stats[]`,
`pillars[]`, `quotes[]`, then two nested lenses — `feature` (one deep-dive:
`name/kicker/status/owner/oneLine/problem/solution/steps/rules/specs/faq/timeline`)
and `arch` (`summary/principles/layers/modules/flow/decisions/risks`). This
is richer than Session Manager's current `ProjectBrief`
(`session-manager-operations/project-brief/`) — Brief has `purpose/what/areas/scope/conventions`
only. Building this library into the app needs a superset synthesis step;
see the architecture walkthrough in this Epic's session for the full gap
list (summary schema, selection algorithm, static-HTML rendering pipeline,
storage ownership).

## Selection hints already encoded

Every variant carries a `note` — several are literally selection predicates
in prose ("Needs a real quote.", "Needs a strong screenshot.", "Best for
technical readers."). A real selection algorithm should formalize these into
machine-checkable `requires`/`idealWhen` tags on each variant rather than
re-deriving them from English at generation time.

## Not the shipped architecture

`40-shell.jsx`'s `ProjectPages` renders JSX transformed **in-browser** via
Babel standalone (`<script type="text/babel">`) and reads Google Fonts via
`@font-face` — fine for a design-tool preview, wrong for a shipped Session
Manager feature (violates "no network egress"; browser-side Babel is slow
and unnecessary bloat). The real pipeline should precompile this library
ahead of time (esbuild) into a pure `renderProjectPages(summary, picks) →
{ marketing, feature, architecture }` function that emits fully self-contained
static HTML strings with locally-hosted fonts, which Project Home then hosts
in a sandboxed iframe — never re-composes live in the app's own React tree.

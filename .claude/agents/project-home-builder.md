---
name: project-home-builder
description: Generates session-manager's 4 static Project Page HTML files (Home / Marketing Landing / Feature Description / Architecture Overview) from the saved component library and a computed project summary.
tools: Read, Grep, Glob, Bash, Write, Edit
---

Project overlay for the generic `project-home-builder` agent
(`~/.claude/agents/project-home-builder.md`) — that file has the general protocol shape; this file
has what's specific to this repo. Read both. (Unlike `builder`'s global file, this one is
version-controlled nowhere else either, but the same "project overlay wins" precedence applies —
this file is what actually runs here.)

Full design spec: [`session-manager-operations/architecture/project-pages-pipeline.md`](../../session-manager-operations/architecture/project-pages-pipeline.md)
— read it before doing anything else. This file only has the operating
protocol; the spec is the source of truth for schemas, file paths and
non-negotiables. If the two ever disagree, the spec wins and this file is
stale — fix this file, don't improvise around it.

## What this agent is for

Runs inside an Epic tagged `project-home-builder` (`src/renderer/lib/
tagLibrary.ts` / `agentTagDefs.ts`). Its whole job is Stages 1-3 of the
pipeline: turn the active project into a computed summary, pick components
from the saved library, and write 4 self-contained static HTML files (Home,
Marketing, Feature, Architecture). It does **not** build the pipeline's
infrastructure (that's regular `/develop` PRD work against the app's own
source) — it's the agent that *runs* the pipeline once the infrastructure
exists, and can also be asked to author that infrastructure the first time
it doesn't exist yet.

## Component library

Never invent components. Three of the four lenses (marketing/feature/
architecture) have a saved design mock at
`session-manager-operations/design-mocks/project-pages-component-library/`
— read its `README.md`, then `source/*.jsx` in the numeric order the
filenames imply (00 → 40; later files splice slots into earlier globals,
see `40-shell.jsx`'s `PAGES` array and each `windows.PAGE_*` assignment).
This is design-tool output extracted to readable JSX, not hand-authored —
treat it as read-only reference, not something to edit in place. The 4th
lens, `home`, has no saved design mock — it was authored directly at
`src/renderer/lib/projectPages/library/homeSlots.tsx`, reusing the same
`identity`/`stats`/`pillars` summary fields the marketing lens's hero/proof/
pillars slots already read, styled as an internal dashboard rather than an
outward pitch. Extending it follows the same rule as the other three: no
invented content, only real `ProjectPageSummary` fields.

## Hard rules

- **Never fabricate.** Every summary field traces to something concrete:
  an Epic goal, a file/dir from the project tree, a CLAUDE.md convention, a
  git log entry, or an existing `project-brief/brief.json` field. No
  invented stats, no invented testimonials/quotes, no invented screenshots
  — an empty/omitted field beats a made-up one every time.
- **Output is static HTML, not a live React composition.** The generated
  pages must not depend on the app's own React tree or Tailwind build at
  display time — self-contained HTML strings only (inline CSS, locally
  hosted fonts, zero network calls, zero runtime JSX transform).
- **Cost-gated, manual only.** Summary synthesis is a `claude -p` pass with
  real cost — never trigger it automatically or in a loop. One run per
  explicit "Generate"/"Regenerate" request.
- **Respect existing hand-picks.** If `picks.json` already has a slot
  choice for this project, keep it on regenerate unless the request is
  explicitly "start over" — same spirit as `project-brief`'s per-block
  pinning.
- **`project-pages/` is agent-authored, not an OWNERS namespace.** You write
  `summary.json`/`picks.json`/`output/*.html` directly with your own Write
  tool — there is no main-process IPC to go through for this (same class as
  `design-mocks/`/`HUMAN_LEARN/`, not `brief.json`). Before creating a new
  `project-home-builder` Epic, check whether one is already active for this
  project and resume it instead — never run two generations for the same
  project concurrently.

## Protocol

1. Read the spec (link above) and the component library's `README.md`.
2. If the pipeline infrastructure (Stage 0 compiled renderer, the
   `ProjectPageSummary`/`ProjectPagePicks` types, the `project-pages` output
   convention) doesn't exist yet in this repo, that is itself the Epic's
   first PRD chain — decompose and queue it via `/develop`, don't hand-roll
   a one-off script that bypasses the real architecture.
3. Once infrastructure exists: read (or generate, if missing/stale) the
   project's `project-brief/brief.json`, compute `ProjectPageSummary`,
   write `project-pages/summary.json`. Then validate it before moving on —
   run `node scripts/validate-project-pages-summary.cjs
   session-manager-operations/project-pages/summary.json` (thin CLI wrapper
   around `validateProjectPageSummary` in `src/renderer/lib/projectPages/
   summaryValidate.ts`; build it first with `npm run
   build:project-pages-logic` if `scripts/project-pages-logic/dist/logic.cjs`
   doesn't exist yet). It exits 0 and prints `valid` on success, or exits 1
   and lists each error (missing/placeholder/wrong-type field) on failure —
   fix `summary.json` and re-run until it passes before proceeding to Stage
   2/3.
4. Do the Stage 2 selection yourself — there is no separate scorer script.
   You already read each lens's slot/variant notes (component library
   README + source files, step 1) and have `summary.json` (step 3). For
   each lens, for each slot, read the candidate variants' prose
   `note`/description and directly choose the one variant that genuinely
   fits this specific project's summary — real judgment, not a formula.
   Write your picks to `session-manager-operations/project-pages/picks.json`
   in the existing `Record<lensId, Record<slotId, variantId>>` shape,
   preserving any existing entries already in that file unless the request
   is explicitly "start over" for specific slots — same rule as "Respect
   existing hand-picks" under Hard rules above.
5. Call the Stage 0 renderer with (summary, picks), write the 3 HTML files
   + `manifest.json` under `project-pages/output/`.
6. Report what was generated and where — Project Home's iframe display
   picks it up from disk; this agent does not touch the renderer's live
   React state directly.

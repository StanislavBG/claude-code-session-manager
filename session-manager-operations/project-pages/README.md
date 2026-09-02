# Project Pages — generated artifact, partly OWNERS-governed

Canonical spec: [`session-manager-operations/architecture/project-pages-pipeline.md`](../architecture/project-pages-pipeline.md)
— read it before touching anything in this folder. This README only
documents what's on disk; the spec is the source of truth for schemas and
the pipeline.

## What's here (once a project-home-builder Epic has run)

```
session-manager-operations/project-pages/
  summary.json     — the computed ProjectPageSummary for THIS project
                      (src/renderer/lib/projectPages/summaryType.ts)
  picks.json        — Stage 2 slot→variant picks (per lens)
  output/
    marketing.html
    feature.html
    architecture.html
    manifest.json   — { generatedAt, ... }
```

## Who writes this folder

Two writers, deliberately:

1. The `project-home-builder` Epic's own claude session, directly, with its
   own `Read`/`Write` tools — reads `project-brief/brief.json` + the repo
   itself and composes `summary.json`/`picks.json` by hand, per the
   corrected Stage 1 in the architecture spec. This path never goes through
   `config.cjs` and is NOT governed by `OWNERS` (see below).
2. The app's own `/admin/project-home/render` route
   (`src/main/lib/projectHomeAdminRoutes.cjs`), added by the
   `project-home-admin-routes` PRD so a generating session on a foreign
   machine (no repo checked out) can hand the app a summary+picks pair over
   HTTP instead of authoring the files itself. This path DOES go through
   `config.cjs`'s `writeJson`/`writeTextAtomic`, writing as `project-home`.

## Why `project-pages` IS an `OWNERS` namespace (owner: `project-home`)

`src/main/lib/opsOwnership.cjs`'s `OWNERS` table (the single-writer law) only
governs writes that go through `config.cjs`'s own write helpers. Writer 1
above (a claude session's own `Write` tool) never passes through `config.cjs`
and so is genuinely unaffected by this declaration — it stays outside the
law by construction, same as before. Writer 2 above is a real main-process
`config.cjs` write path, and before this PRD it had no declared owner, which
means `checkOpsWrite`'s fail-closed default (`no declared owner for
session-manager-operations/project-pages/`) would have refused every
`/admin/project-home/render` call. Declaring `project-pages: 'project-home'`
in `OWNERS` closes that gap for writer 2 without changing anything about
writer 1 — see the comment on that `OWNERS` entry in `opsOwnership.cjs` for
the same explanation in code.

This keeps `project-pages/` similar in spirit to
[`design-mocks/`](../design-mocks/project-pages-component-library/README.md)
and `HUMAN_LEARN/` — still mostly agent-authored artifact output — while
also giving it the same `OWNERS` protection as
[`project-brief/`](../project-brief/README.md) for the one write path that
actually goes through `config.cjs`.

## How concurrency is actually handled here

Two independent guards, one per writer, and NEITHER defends against the
other — an Epic hand-authoring these files while `/admin/project-home/render`
lands for the same cwd can still interleave (known gap, tracked for the
MCP-tool-surface PRD that will make render callable from outside this app):

- Writer 1 (the Epic's own Write tool): "Generate Now" in Project Home must
  check whether a `project-home-builder` Epic is already active for this
  project and **resume/focus it** instead of starting a second one — the
  same "refuse a live session" guard `deleteEpic` already uses elsewhere.
  Two concurrent generations for the same project is a UX bug to prevent at
  the Epic-creation layer, not a race this folder's layout defends against.
- Writer 2 (`/admin/project-home/render`, `projectHomeAdminRoutes.cjs`): an
  in-process, per-cwd promise chain serializes overlapping HTTP render calls
  against EACH OTHER only — it has no visibility into, and does not wait
  for, a separate `claude` CLI process's own Write-tool calls for the same
  cwd. There is currently no cross-process lock between the two writers.

## Validating `summary.json` before Stage 2/3

Two equivalent ways to run the same `validateProjectPageSummary` check
(`src/renderer/lib/projectPages/summaryValidate.ts`), both against the
shipped compiled bundle so neither needs a build step:

- Locally, with this repo checked out:
  `scripts/validate-project-pages-summary.cjs <path to summary.json>`.
- From a foreign machine with no repo checked out (or from the app itself):
  `POST /admin/project-home/validate-summary` with `{cwd, summary}` —
  see `GET /admin/project-home/contract?cwd=<abs>` for the full protocol,
  schema and catalog this needs, with zero repo knowledge required.

`.claude/agents/project-home-builder.md`'s protocol uses whichever is
available and catches a malformed or placeholder-filled summary before it
reaches Stage 2 selection or the Stage 3 renderer.

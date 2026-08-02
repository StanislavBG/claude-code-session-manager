# Project Pages — generated artifact (agent-authored, not an OWNERS namespace)

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

The `project-home-builder` Epic's own claude session, directly, with its own
`Read`/`Write` tools — never session-manager's main process. There is no
IPC call, no `config.cjs` write path, and no backend synthesis job that
produces `summary.json`; the Epic reads `project-brief/brief.json` + the
repo itself and composes the summary by hand, per the corrected Stage 1 in
the architecture spec.

## Why this is NOT an `OWNERS` namespace

`src/main/lib/opsOwnership.cjs`'s `OWNERS` table (the single-writer law) only
governs writes that go through `config.cjs`'s own write helpers, plus two
raw-`fs` main-process modules (`epicMint.cjs`, `queueStore.cjs`). Its
fail-closed `assertOpsWrite` check has no way to intercept a claude session's
own `Write` tool calls — those never pass through `config.cjs` at all. Since
every file in this folder is written that way, `OWNERS` cannot enforce
anything here even in principle, so declaring `project-pages` as an `OWNERS`
namespace would be a claim the code can't back up.

This puts `project-pages/` in the same class as
[`design-mocks/`](../design-mocks/project-pages-component-library/README.md)
and `HUMAN_LEARN/` — agent-authored artifact output, one author per
invocation — rather than the same class as
[`project-brief/`](../project-brief/README.md), which IS an `OWNERS`
namespace because `project-brief.cjs` writes it through `config.cjs` from
the main process and a second writer really could race it.

## How concurrency is actually handled here

Not by filesystem write arbitration (there's nothing to arbitrate — one
agent session, one set of Write calls, no lock to take). "Generate Now" in
Project Home must check whether a `project-home-builder` Epic is already
active for this project and **resume/focus it** instead of starting a
second one — the same "refuse a live session" guard `deleteEpic` already
uses elsewhere. Two concurrent generations for the same project is a UX bug
to prevent at the Epic-creation layer, not a race this folder's layout
defends against.

## Validating `summary.json` before Stage 2/3

`.claude/agents/project-home-builder.md`'s protocol runs
`scripts/validate-project-pages-summary.cjs <path to summary.json>` (thin
CLI wrapper around `validateProjectPageSummary` in
`src/renderer/lib/projectPages/summaryValidate.ts`) against its own
`summary.json` before moving on — catches a malformed or placeholder-filled
summary before it reaches the Stage 2 selection scorer or the Stage 3
renderer.

---
name: pr-review-sweep
description: Sweep one or more of the current project's PRs' unresolved review comments end-to-end — fetch (paginated), classify by disposition AND bug-vs-feature type, check-if-already-fixed, queue a scheduler PRD per (PR, type), then land-and-resolve once it completes. Orchestrates 5 nested sub-skills (pr-review-sweep:fetch, :classify, :check-fixed, :queue, :land-and-resolve). Never fixes inline, never contacts reviewers. Use when a PR has open review feedback that needs triaging and landing.
---

# pr-review-sweep (orchestrator)

Global, project-agnostic PR-review-clearing pipeline — works against whatever repo the
current project's `gh` remote points to. Run this per-PR whenever `/project-status` (or a
manual check) surfaces unresolved review threads. Codified from the process used to clear
review rounds on `midt-bg/sigma` PRs; a project's own `AGENTS.md`/`CLAUDE.local.md` may add
repo-specific policy notes (e.g. which threads are auto-accept vs. needs-decision, house
style for reply text) that this skill should read and respect if present.

**Naming convention (see a project's own `AGENTS.md` if it documents one; otherwise this
convention still applies as the plugin's own standard):** sub-skill directories are prefixed
`0-`, `1-`, ... in execution order, so a plain directory listing sorts in DAG order without
opening any file. The invocable `name:` field stays a clean colon-scoped identifier
(`pr-review-sweep:fetch`) without the numeric prefix.

**Always via the scheduler.** Every genuinely-unfixed thread is fixed by a `/develop` PRD,
never inline in this session — no "fast path" for small mechanical fixes. The scheduler is
the one place real code changes happen (global CLAUDE.md model-economics rule: interactive
sessions run an expensive planner-tier model; execution belongs on the cheap executor
tier). If a fast lane for small review fixes turns out to be worth having, that's a
scheduler-level feature (a priority/fast queue lane) to build later — not a reason for this
skill to bypass the scheduler now.

## Pipeline DAG

```
PR number(s)
      │
      ▼
┌───────────────────────────┐
│ 0. pr-review-sweep:fetch       │  paginated GraphQL, reviewThreads.isResolved ground truth
└───────────────────────────┘
      │ every unresolved thread, full text + location
      ▼
┌───────────────────────────┐
│ 1. pr-review-sweep:classify    │  disposition (accept/policy-override/needs-decision)
└───────────────────────────┘     × type (bug/feature) — two independent axes
      │ per thread: {disposition, type}, needs-decision threads set aside
      ▼
┌───────────────────────────┐
│ 2. pr-review-sweep:check-fixed │  MANDATORY for every survivor — triage into 3 outcomes
└───────────────────────────┘     before queuing or replying to anything
      │              │                      │
      │ already-fixed│ reply-only            │ survives (genuinely needs new code)
      ▼              ▼                      ▼
      └──────┬───────┘          ┌───────────────────────────┐
             │                  │ 3. pr-review-sweep:queue       │  one /develop PRD per
             │                  └───────────────────────────┘  (PR, type) bundle,
             │                        │ queued PRD id, or         duplicate-guarded
             │                        │ "already queued"
             │                        ▼
             │                  ... async, on scheduler ...
             │                        │
             ▼                        ▼
       ┌───────────────────────────────────┐
       │ 4. pr-review-sweep:land-and-resolve    │  cite SHA (already-fixed/PRD) or
       └───────────────────────────────────┘  reasoning (reply-only); reply; resolve
                     │
                     ▼
       thread resolved, or reported stuck (failed/needs_review PRD)
```

| Step | Input | Output | On failure/empty |
|---|---|---|---|
| 0. `pr-review-sweep:fetch` | one or more PR numbers | every unresolved review thread, verified-complete (paginated) | n/a — loops its own fetch until `totalCount` matches nodes paged |
| 1. `pr-review-sweep:classify` | unresolved threads | each thread tagged `{disposition, type}` | needs-decision threads are set aside, surfaced to the user, never guessed |
| 2. `pr-review-sweep:check-fixed` | accept/policy-override threads — **every one, no shortcuts** | `already-fixed` (w/ commit) + `reply-only` (w/ reasoning) + `survives` | never skip this because a thread's disposition "obviously" needs no code check — see the incident documented in that step's own file |
| 3. `pr-review-sweep:queue` | `survives` only, grouped by (PR, type) | one queued `/develop` PRD id per bundle | if a PRD for that (PR, type) is already queued/in-flight, skip and report its id — never double-queue |
| 4. `pr-review-sweep:land-and-resolve` | already-fixed / reply-only (immediate) or a PRD reported `completed` by the scheduler | thread replied (SHA or reasoning) + resolved | `failed`/`needs_review`/stuck PRDs are reported, never silently retried |

## Why two independent classification axes (step 1)

**Disposition** (accept-as-is / policy-override / needs-my-decision) answers "should this
be done at all, and does it need a human." **Type** (bug / feature) answers "what shape of
change is this, once we've decided to do it" — and drives which PRD template/acceptance
criteria `pr-review-sweep:queue` writes:

- **Bug** — the reviewer flagged something objectively broken (wrong output, crash,
  security issue, off-by-one, missed edge case). The PRD's ACs require: a reproduction of
  the defect, a regression test that fails before the fix and passes after, then the fix
  itself.
- **Feature** — the reviewer asked for additional behavior, a refactor, or a
  consistency/style improvement that isn't fixing broken behavior. The PRD's ACs require
  scoping tightly to exactly what was asked (no piggybacked scope creep) and consistency
  with existing patterns in the touched file; a regression test is only required if the ask
  itself adds testable behavior.

Splitting by type — rather than one undifferentiated "fix it" PRD per PR — is what lets each
bundle get acceptance criteria actually suited to the kind of work it is, and is the reason
this classification exists as its own step rather than being folded into disposition.

## Hard constants across all five steps

- **Ground truth for "unresolved" is GraphQL `reviewThreads.isResolved`**, fully paginated
  (`first: 100` — smaller page sizes have silently truncated on real PRs; always compare
  `totalCount` to nodes actually paged through). Never a last-reply/last-push heuristic.
- **Never contact a reviewer** — no request, re-request, or nudge, at any point in this
  process. Reviewer contact is `pr-signal`'s job alone, gated behind the user's explicit,
  per-PR, freshly-given approval every time. A prior approval never carries forward.
- **Never fix inline.** Every genuinely-unfixed thread goes through `/develop`, no
  exceptions — see the scheduler note above.
- **Idempotent re-runs.** One queued/in-flight PRD per (PR, type) bundle; replies aren't
  re-posted; resolving an already-resolved thread is a no-op.

## Why nested skills instead of one inline sequence

Each step is its own file so it shows up as its own invocation in whatever surface tracks
skill/tool calls, and so a step can be changed (a new PRD template for a third `type`
bucket, a different fetch page size) without touching the others. `classify` is the step
most likely to grow — if a third type axis value earns its own PRD template later (e.g.
`docs`, `perf`), or `queue` needs different bundling logic per type, decompose that step
further the same way `issue-address:select` was, rather than growing this file.

## What this skill is not

- Not for GitHub issues — that's `issue-address` (a different data source: issues, not
  open-PR review threads).
- Not a decision on whether to contact a reviewer — that's `pr-signal`, invoked separately
  and rarely.

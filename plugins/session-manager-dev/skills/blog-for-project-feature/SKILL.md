---
name: blog-for-project-feature
description: Produce a self-contained, interactive HTML "feature showcase" for one project + one feature — Project Mission & Description, Feature Description (with an optional generated companion illustration), and a Click-Through Demo built from REAL screenshots (never mockups) — one aspect revealed at a time. Output is a single portable HTML file uploadable anywhere (no server, no build step). Distinct from blog-from-git (which drafts narrative bilko.run changelog posts from git history) — this is an evergreen, per-feature product page, not a dated post. Orchestrates 8 nested sub-skills (blog-for-project-feature:select, :research, :storyboard, :capture, :draft-copy, :illustrate, :compose, :review) so each step is independently invokable and inspectable. Use for "make a feature page for X", "showcase this feature", "/blog-for-project-feature", "interactive demo of X", or turning a shipped feature in Session Manager / Social Signal Builder (or any project) into something you can hand someone a link to.
---

# blog-for-project-feature (orchestrator)

Project-agnostic. Runs against whatever project the current working directory (or a named
project path) points to — built first for **Session Manager** and **Social Signal Builder**,
but nothing here is hardcoded to either.

**Not `blog-from-git`.** That skill drafts a dated, narrative bilko.run post from git activity
("here's what shipped this week"). This skill produces an **evergreen, single-feature product
page** — no date, no changelog framing, not tied to a publishing cadence. One project, one
feature, three things: what the project is for, what this feature does, and a real click-through
demo of it working. The two skills never share output or ledger state.

**`feature.config.yaml` in this folder is the grounding authority** for output conventions
(where the HTML lands, image size/compression limits, single-file-vs-folder default, theme
tokens). Read it first, before any sub-skill file. If prose here ever disagrees with the config,
the config wins.

## Pipeline DAG

```
project (+ optional feature name)
              │
              ▼
┌───────────────────────────────┐
│ 0. blog-for-project-feature:select │──▶ one confirmed project + one confirmed feature
└───────────────────────────────┘
              │
              ▼
┌───────────────────────────────┐
│ 1. :research                       │──▶ mission, feature description, key files/entry points
└───────────────────────────────┘
              │
              ▼
┌───────────────────────────────┐
│ 2. :storyboard                     │──▶ ordered demo steps (action, expected screen, caption)
└───────────────────────────────┘
              │
              ▼
┌───────────────────────────────┐
│ 3. :capture                        │──▶ real screenshots per step (+ storyboard corrections)
└───────────────────────────────┘        │ no real screenshot obtainable for a step
              │ all steps captured        ▼
              ▼                    STOP — report which step blocked, don't fabricate
┌───────────────────────────────┐
│ 4. :draft-copy                     │──▶ FINAL mission/feature text + one-sentence "essence" line
└───────────────────────────────┘
              │
              ▼
┌───────────────────────────────┐
│ 5. :illustrate                     │──▶ one companion illustration from the essence line
└───────────────────────────────┘        (or a clean "omitted" note — never blocks the pipeline)
              │
              ▼
┌───────────────────────────────┐
│ 6. :compose                        │──▶ one self-contained interactive HTML file
└───────────────────────────────┘
              │
              ▼
┌───────────────────────────────┐
│ 7. :review                         │──── fails a check ────┐
└───────────────────────────────┘                            │
              │ passes                                        │
              ▼                                                │
     report path, wait for explicit                            │
     "publish/upload" instruction          loop back to :compose / :capture / :illustrate
```

| Step | Input | Output | On failure |
|---|---|---|---|
| 0. `:select` | project (cwd or named) + optional feature hint | one confirmed project + one confirmed feature name + why it's demo-worthy | **STOP** — report if no clear feature can be confirmed (don't guess) |
| 1. `:research` | confirmed project + feature | mission/description (project-level), feature description, key files, how it actually works | n/a — always produces notes, flags gaps explicitly rather than inventing claims |
| 2. `:storyboard` | mission + feature notes | ordered list of `{step, action, expected_screen, capture_scope, caption}`, 5-10 steps, a deliberate mix of full-page and component-scoped shots | n/a — storyboard is a draft, `:capture` is allowed to correct it |
| 3. `:capture` | storyboard | one real screenshot file per step + any corrected captions | **STOP** on that step — report what's missing; never substitute a placeholder/mockup image |
| 4. `:draft-copy` | research notes + captured captions | final Mission & Feature Description prose + one-sentence essence line | n/a — always produces final text, gaps stay explicit |
| 5. `:illustrate` | the essence line (text must exist first) | one companion illustration, tagged distinct from screenshots — or an explicit omission note | never blocks — skips cleanly if no image generator is configured, or after one off-brief retry |
| 6. `:compose` | final copy + captured steps + optional illustration | one self-contained HTML file (or html+images folder per config) | loop back to `:capture` if a required image is missing, else fix and retry |
| 7. `:review` | the composed HTML | pass/fail against the gate below | loop back to `:compose` (content), `:capture` (screenshot), or `:illustrate` (mislabeled companion image) — never ship on a failed gate |

## Golden rule: screenshots are real or the step doesn't exist

This skill exists specifically because "feature demo" content is worthless if the images are
invented, stale, or from the wrong build. `:capture` uses `mcp__playwright__*` (or the project's
own screenshot tooling if `run`/a project skill already drives it — check for one first) against
a running instance of the actual project. If a step can't be captured for real (app won't start,
feature is behind auth you don't have, flow requires data that doesn't exist locally), **that
step is dropped and reported, not faked.** A shorter, honest demo beats a complete, fabricated one.

## Output

Default: one self-contained `.html` file (inline CSS/JS, base64-embedded images) written to
`docs/feature-showcase/<project-slug>-<feature-slug>.html` inside **`~/Projects/Bilko`** —
never inside the showcased project's own repo, even when the feature being showcased belongs
to a different project entirely. Bilko is the author/publisher of every showcase (same as
`blog-from-git`'s posts), is guaranteed to be locally writable across sessions, and these pages
are destined to eventually post to bilko.run — so output collects in one place from the start.
See `feature.config.yaml` for the exact path convention, size ceiling, and the single-file vs.
folder fallback (used when embedded images would blow past the size ceiling). This is what
"uploadable anywhere" means: no server, no relative asset paths, no build step — open the file
or drop it on any static host and it works.

**Only push, deploy, or upload when explicitly asked.** Report the local path and a one-line
description of what the page shows, and wait — same convention as `blog-from-git`'s seed gate
and `issue-address`'s "only push when asked" rule.

## Why nested skills instead of one inline pass

Same reasoning as `issue-address` and `pr-review-sweep`: each phase is a real, independently
invokable `SKILL.md` so progress is visible step by step ("storyboard produced 5 steps, capture
got 4 real screenshots, 1 dropped") instead of one opaque generation pass, and a single phase
(e.g. swapping the screenshot tool, changing the HTML theme) can be edited without touching the
others. If a step is still doing too much once this ships, decompose it further the same way
`issue-address:select` was (nested sub-DAG) — continuously, wherever one file covers too much to
inspect as one unit.

## Folder map

```
blog-for-project-feature/
  feature.config.yaml ← output path convention, size ceiling, theme tokens — read first
  SKILL.md             ← this file: pipeline, DAG, output contract
  0-select/SKILL.md
  1-research/SKILL.md
  2-storyboard/SKILL.md
  3-capture/SKILL.md
  4-draft-copy/SKILL.md
  5-illustrate/SKILL.md
  6-compose/SKILL.md
  7-review/SKILL.md
```

## What this skill is not

- Not `blog-from-git` — no dated post, no rotation ledger, no git-diff scan. This is
  feature-scoped and evergreen; that skill is time-scoped and narrative.
- Not a marketing copy generator — every claim in `:research`'s output must trace to real code,
  docs, or a live screenshot, same evidentiary bar as `blog-from-git`'s `ground.md`.
- Not a full site generator — one feature, one page, per run. A project with N features worth
  showcasing gets N runs (and, if wanted later, a separate index/landing skill — not built yet,
  don't invent one inline).

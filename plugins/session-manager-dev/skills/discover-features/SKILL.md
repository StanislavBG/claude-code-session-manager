---
name: discover-features
description: >-
  Propose and prototype NEW features for the current project. Reads the project's issues, PRs,
  `main`, and md/docs to learn its objectives, then runs THREE independent discovery sessions
  (each may also web-search for ideas) that every one proposes 5 high-level feature ideas best
  fitting the project's goals — 15 total. Synthesises and ranks them, picks the top 3, and runs a
  high-quality `/develop` build for each. Delivers a deployed URL per feature plus a validation
  checklist so the human can try them — and NEVER opens a PR or a GitHub issue from a proposed
  feature (the human validates first, then decides). Use when the user says "/discover-features",
  "propose features", "discover feature opportunities", "what should we build next", "prototype
  some new features for me to try". Keywords: discover, propose, feature, opportunity, ideation,
  prototype, what's next, roadmap.
---

# /discover-features — propose → prototype → hand over URLs (no PRs)

**Role:** the *generative* counterpart to `/find-opportunity`. `/find-opportunity` triages the
*existing* backlog to pick the next issue to resolve; `/discover-features` *invents* net-new
features the backlog doesn't contain yet, prototypes the best ones, and hands the human running
URLs to validate. It is for "what should we build next?", not "which open issue next?".

**Hard rules (do not violate):**
- **Never open a PR or a GitHub issue** from a proposed feature. The deliverable is a *running,
  validatable prototype on a branch* + a URL + a validation checklist — the human decides what
  (if anything) becomes a PR. (See the `solve-dont-open-issues` principle.)
- **No fabricated data.** Prototypes run on the project's real data layer / real queries. If a
  feature needs data that doesn't exist, it shows an honest empty state — never seeded fakes.
- **Don't touch `main`.** Build on a fresh branch (or worktrees) off the latest `main`.
- **Respect the conflict-skip sense** (from `/find-opportunity`): don't prototype something an
  open PR is already building.

## Phase 0 — Ground in the project's objectives

Before ideating, learn what the project is *for* (so ideas fit, not just dazzle):
```bash
gh issue list --state open --limit 100 --json number,title,labels
gh pr list   --state all  --limit 60  --json number,title,headRefName,state
ls docs/ README.md AGENTS.md CLAUDE.md 2>/dev/null
```
Read the design docs / README / AGENTS for the mission, the north-star, the explicit
non-goals/constraints, and the data model. Extract a short **objectives + constraints** brief —
this is the anchor every discovery session and the ranking use.

## Phase 1 — THREE independent discovery sessions (fan-out)

Spawn **3 independent agents in parallel**. Each gets the objectives brief and is told to think
differently from the others (assign distinct stances, e.g. *user-value first* / *data-leverage
first* / *differentiation-&-novelty first*). Each agent:
- Re-reads the issues / PRs / `main` / docs itself (independent grounding, not just your brief).
- **May web-search** for ideas — comparable products, domain best-practice, what peer
  civic/▢-tech projects ship — and bring back what genuinely fits.
- Returns **exactly 5 high-level feature ideas**, each with: one-line pitch; which project
  objective it advances; the data/infra it leans on (must already exist or be honestly stubbable);
  rough surface (new route/page is preferred so it's independently deployable + validatable); a
  novelty/﻿effort/impact read. Be creative — no artificial limits.

15 ideas total. Keep each agent blind to the others (diversity > consensus).

## Phase 2 — Synthesise & rank → top 3

Merge the 15. De-dupe near-identicals (keep the sharpest framing). Drop anything that: an open PR
already builds, needs data the project doesn't have, or is a multi-week epic that can't reach a
*validatable* prototype in one build. Rank the survivors by **objective-fit × user-value ×
prototype-feasibility**. Pick the **top 3**. State *why* each won and what you dropped (no silent
cuts). Prefer 3 that are independently deployable (separate routes) so the human can validate each
in isolation.

## Phase 3 — High-quality build of each top-3 feature

For each of the 3, run a `/develop` `quality: high`-style build (deep-check → plan → implement →
tests → self-validate). Build all three on **one branch** (or worktrees) so a single running app
serves all three. Wire each as its own route/page where possible. Real data via real queries;
honest empty states. Typecheck + the project's tests must pass before you call a feature done.

## Phase 4 — Deploy locally & hand over (NO PR)

Launch the project's dev server (or preview) so the features are reachable. Deliver, per feature:
- **The URL** it's live at (e.g. `http://localhost:<port>/<route>`).
- **What it does** in two lines + which objective it serves.
- **A validation checklist** — concrete things for the human to click/observe to judge it
  ("filter to sector X, confirm the sparkline matches the table total", "open on mobile width",
  "try an entity with no data → honest empty state").
- Note any assumptions or stubs.

End with: the branch name (un-pushed), the 3 URLs, and "say which to keep → I'll turn those into
PRs." **Do not push or PR anything yourself.**

## Notes
- This skill is token-intensive by design (3 discovery sessions + 3 builds). Run it when the user
  has explicitly asked for a feature-ideation+prototype round, typically as an overnight batch.
- If the dev server can only serve one branch at a time, that's fine — all three features share
  the one branch and one server; give three routes/URLs on it.
- Keep ideas anchored to the project's actual objectives — a brilliant idea that fights the
  mission is noise. Creativity in service of the goal, not despite it.

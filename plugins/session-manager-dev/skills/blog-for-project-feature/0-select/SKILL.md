---
name: blog-for-project-feature:select
description: Step 0 of blog-for-project-feature — confirm exactly ONE project and ONE feature to showcase. Only asks the user when the feature genuinely can't be inferred; otherwise picks the most demo-worthy recently-shipped feature and states why.
---

# blog-for-project-feature:select

## Input
- The project: current working directory's repo, or a project name/path explicitly given by
  the caller.
- Optional: a feature name or hint from the caller ("showcase the click-run screen", "the new
  ticker-tracker queue").

## Steps

1. **Confirm the project.** Read its root `CLAUDE.md`/`README.md`/`AGENTS.md` (whichever
   exists) to confirm you're pointed at a real, buildable/runnable project — not an empty or
   scaffold-only repo.

2. **If a feature was named**, confirm it exists: grep for it in code, routes, or docs. If it
   doesn't resolve to anything real, say so and stop rather than guessing at a nearby feature.

3. **If no feature was named**, pick one:
   - Prefer something with a real UI surface (a screen, a flow, a page) — this skill's whole
     value is a click-through demo, so a pure-backend/CLI-only feature is a weak fit unless the
     project exposes it through a dashboard.
   - Prefer recently shipped (`git log --oneline -20` on the relevant paths) over long-stable —
     showcases are most useful for things a reader hasn't seen yet.
   - Prefer one coherent flow over a grab-bag of unrelated changes — this produces ONE feature
     page, not a changelog.

4. **State the justification** in one or two sentences: what the feature is, why it's the right
   one to demo right now.

## Output

Hand off to `:research`: confirmed project (path/repo), confirmed feature name, one-line
justification. If no confirmable feature exists, **STOP** and report why instead of forcing a
pick.

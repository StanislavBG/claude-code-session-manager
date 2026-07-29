---
name: blog-for-project-feature:storyboard
description: Step 2 of blog-for-project-feature — turn the feature notes into an ordered, one-aspect-at-a-time sequence of demo steps, each with a planned action, expected screen, and caption. A draft for :capture to execute and correct against reality.
---

# blog-for-project-feature:storyboard

## Input
Mission/description + feature description + demo surface (routes, run command, setup), from
`:research`.

## Steps

1. **Break the feature into aspects**, not just clicks. Each storyboard step should reveal ONE
   idea — a screen, a state change, a result — not an arbitrary UI action. 4-8 steps is a good
   range; fewer feels thin, more starts diluting the "one aspect at a time" promise.

2. **For each step, define:**
   - `step`: index + short name (e.g. `2-queue-populated`)
   - `action`: the exact interaction to perform to reach this state (navigate to X, click Y,
     submit form with Z) — precise enough that `:capture` can execute it without re-deciding
   - `expected_screen`: what should be visible when the action completes — this is the
     hypothesis `:capture` verifies against the real app
   - `caption`: one sentence, written for the reader of the final page, naming what changed on
     screen (not internal mechanics)

3. **Order for narrative sense**: typically entry point → the feature's core interaction →
   the result/outcome it produces. Match `content.demo_interaction` in `feature.config.yaml`
   (one-step reveal, not a scroll dump) — so the order IS the reveal sequence.

4. **Note any setup steps** needed before step 1 is reachable (login, seed data, feature flag)
   — hand these to `:capture` explicitly so it isn't guessing at prerequisites.

## Output

Hand off to `:capture`: the ordered step list (`step`, `action`, `expected_screen`, `caption`)
plus any setup/prerequisite steps. This is a draft — `:capture` is expected to correct captions
or drop steps that don't match what the real app actually shows.

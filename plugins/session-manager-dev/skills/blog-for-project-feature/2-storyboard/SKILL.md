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
   idea — a screen, a state change, a result — not an arbitrary UI action. **5-10 steps** ("swipes")
   is the target range; fewer feels thin, more starts diluting the "one aspect at a time" promise.

2. **For each step, define:**
   - `step`: index + short name (e.g. `2-queue-populated`)
   - `action`: the exact interaction to perform to reach this state (navigate to X, click Y,
     submit form with Z) — precise enough that `:capture` can execute it without re-deciding
   - `expected_screen`: what should be visible when the action completes — this is the
     hypothesis `:capture` verifies against the real app
   - `capture_scope`: `full_page` or `component` (see the composition recipe below) — plus, when
     `component`, which element/region to frame (a CSS selector, ARIA role+name, or plain
     description precise enough for `:capture` to target a single element screenshot instead of
     the whole viewport)
   - `caption`: one sentence, written for the reader of the final page, naming what changed on
     screen (not internal mechanics)

3. **Compose the sequence with this recipe — authoritative, not a suggestion.** A full-page shot
   every step is disorienting (the reader has to re-find the relevant thing each time); an
   all-component sequence loses context (the reader forgets where they are in the app). Mix them
   deliberately in this arc:
   - **Orientation (1 step, `full_page`).** Where the feature lives in the real product — the
     screen the reader would actually land on. Establishes context before zooming in.
   - **Mechanism (2-5 steps, `component`).** The actual control, interaction, or state change,
     cropped/framed to just that component so the reader's eye isn't hunting across a full
     screen for what changed. This is the bulk of the demo — most features are *shown* here.
   - **Variation or depth (0-2 steps, mixed).** Secondary states, options, or edge cases worth
     surfacing. Default to `component`; use `full_page` only if the variation reshapes the whole
     screen (a new page, a full dashboard swap) rather than one region of it.
   - **Outcome (1-2 steps, `full_page`).** The result landing back in the real product, in
     context — proof the feature actually changed something the user will encounter, not just a
     component in isolation.

   Decision rule when a step doesn't obviously fit: default to `component` — it isolates the
   thing being demonstrated and reads more clearly at small size. Only use `full_page` for
   orientation/outcome steps, or when the change genuinely spans the whole viewport (new page,
   layout shift, multi-panel result) and a cropped shot would lose the point.

4. **Order for narrative sense**: entry point → mechanism → variation → outcome, per the recipe
   above. Match `content.demo_interaction` in `feature.config.yaml` (one-step reveal, not a
   scroll dump) — so the order IS the reveal sequence.

5. **Note any setup steps** needed before step 1 is reachable (login, seed data, feature flag)
   — hand these to `:capture` explicitly so it isn't guessing at prerequisites.

## Output

Hand off to `:capture`: the ordered step list (`step`, `action`, `expected_screen`,
`capture_scope`, `caption`) plus any setup/prerequisite steps. This is a draft — `:capture` is
expected to correct captions, adjust `capture_scope` if the planned framing doesn't hold up
against the real screen, or drop steps that don't match what the real app actually shows.

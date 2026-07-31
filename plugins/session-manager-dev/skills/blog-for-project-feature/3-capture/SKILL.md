---
name: blog-for-project-feature:capture
description: Step 3 of blog-for-project-feature — drive the REAL running app and take a real screenshot per storyboard step. Never fabricates or mocks an image; drops and reports any step it can't actually reach.
---

# blog-for-project-feature:capture

## Input
Ordered storyboard steps (`step`, `action`, `expected_screen`, `capture_scope`, `caption`) +
setup steps, from `:storyboard`.

## Steps

1. **Get the app running for real.** Check for an existing project skill that already knows how
   to launch it (e.g. a `run` skill) before improvising. If none exists, use the project's own
   documented run command from `:research`'s demo surface notes.

2. **Execute setup steps first** (login, seed data, navigation to the feature's entry point) —
   exactly as specified by `:storyboard`, adjusting only if the real app's actual flow differs
   (e.g. a login form field is named differently than assumed).

3. **For each storyboard step, in order:**
   - Perform the `action` using `mcp__playwright__browser_navigate` /
     `browser_click` / `browser_type` / etc.
   - Take the screenshot per the step's `capture_scope`:
     - `full_page`: `mcp__playwright__browser_take_screenshot` for the full viewport/page.
     - `component`: use a `ref`/element target (via `browser_snapshot` to locate the element,
       then an element-scoped `browser_take_screenshot`) framed to the specific control or
       region the step calls out — not the whole viewport. If the described element can't be
       resolved to a single clean region, fall back to `full_page` for that step rather than
       guessing at a crop.
   - Compare what actually rendered against `expected_screen`. If it matches: keep the step,
     correct the caption only if something material differs (a number, a label). If the planned
     `capture_scope` doesn't hold up (the "component" is actually two disconnected regions, or a
     "full_page" shot is so busy the point gets lost), correct `capture_scope` for that step
     before saving. If the step doesn't match `expected_screen` at all (error state, feature not
     reachable, requires access you don't have): **drop this step and record why** — do not
     screenshot an error page and caption around it, and never substitute a mockup, wireframe, or
     hand-drawn image for a missing real one.

4. **Save images** per `feature.config.yaml`'s `images` block (format, max width, compression) —
   downscale before handing to `:compose`, don't pass raw multi-MB captures through.

5. **If a majority of steps drop**, stop and report — the feature isn't in a demoable state
   right now; that's a valid outcome to surface to the user, not something to force through with
   a thin 1-2 step demo.

## Output

Hand off to `:compose`: for each surviving step, the real image file + final caption; plus an
explicit list of any dropped steps and why. `:compose` must never receive more steps than were
actually captured.

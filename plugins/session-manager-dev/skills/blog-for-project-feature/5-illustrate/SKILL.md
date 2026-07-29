---
name: blog-for-project-feature:illustrate
description: Step 5 of blog-for-project-feature — generate ONE companion illustration that captures the feature's essence, from the finalized copy (not before it exists). Runs after :draft-copy, before :compose. Skips cleanly (never blocks the pipeline) when no image-generation capability is configured.
---

# blog-for-project-feature:illustrate

Runs strictly **after** `:draft-copy` — the companion image is generated from the finalized
essence line, not from raw research notes, so it actually reflects what the page ends up saying
rather than an earlier draft of it.

## Input
The one-sentence "essence" line + final Feature Description, from `:draft-copy`.

## Steps

1. **Check for an available image-generation capability** before doing anything else, in this
   order:
   - a project-local generator the target project already has wired up (e.g. Burrow's own
     `app/shared/image_gen.py`) — reuse it as-is rather than reimplementing
   - otherwise, **default to the Gemini API** (same provider/pattern as Burrow's
     `image_gen.py`: `gemini-2.5-flash-image` via `google-genai`) using whatever Gemini API key
     is available in the environment (`GEMINI_API_KEY` / `GOOGLE_API_KEY`) — this is the
     standard path for projects with no generator of their own yet
   - **if no Gemini key or other generator is available, skip this step cleanly** — report "no image-generation capability
     available, companion image omitted" and hand `:compose` nothing. This is a valid, expected
     outcome on environments without a configured image provider — never block the pipeline on
     it, and never substitute a stock photo, icon pack graphic, or hand-placed screenshot as a
     stand-in for a generated illustration (that would violate the same no-fabrication rule
     `:capture` follows, just for a different image class).

2. **If available, generate exactly ONE image** from a prompt built as: the essence line +
   `feature.config.yaml`'s `illustration` style tokens (mood/palette/composition) + an explicit
   instruction that this is a conceptual/editorial illustration, NOT a UI mockup or screenshot
   — it must be visually distinguishable at a glance from the real click-through screenshots
   (no fake window chrome, no invented UI text). This distinction matters: `:review` gate 2
   checks that nothing generated here could be mistaken for a real captured screen.

3. **Save and size** per `feature.config.yaml`'s `illustration` block (format, max dimensions,
   compression) — same discipline as `:capture`'s screenshot handling.

4. **One regeneration attempt max** if the first result is off-brief (wrong subject, contains
   text/UI chrome it shouldn't). If still off after one retry, drop it and report rather than
   shipping a confusing image.

## Output

Hand off to `:compose`: either one companion image file (clearly tagged as `kind: illustration`,
distinct from `kind: screenshot` steps from `:capture`), or an explicit "omitted — no generator
available" / "omitted — two attempts off-brief" note.

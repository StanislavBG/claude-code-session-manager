---
name: blog-for-project-feature:review
description: Step 7 of blog-for-project-feature — check the composed HTML against feature.config.yaml's gate list before reporting it ready. Loops back to :compose for content issues, :capture for screenshot gaps, or :illustrate for a mislabeled companion image; never ships on a failed gate.
---

# blog-for-project-feature:review

## Input
Path to the composed HTML (or html+folder) + output mode + size, from `:compose`.

## Steps

Check every item in `feature.config.yaml`'s `gates` list against the actual file:

1. Open it (or inspect its markup directly) and confirm every image reference resolves — for
   base64-embedded images this means the data URI is present and non-empty; for the folder mode,
   confirm each referenced file actually exists on disk.
2. Confirm zero placeholder/mockup images slipped through — cross-check every `kind: screenshot`
   image against `:capture`'s reported real captures; anything not in that list is a violation.
   If a companion illustration is present, confirm it's placed only in the Feature Description
   header (never inside the Click-Through Demo) and is visually distinguishable from a real
   screenshot (no fake window chrome/UI text) — if it could pass as a captured screen, that's a
   violation too.
3. Confirm all three required sections are present and non-empty (or explicitly gap-noted per
   `:compose` step 5, which is an acceptable non-empty state). The companion illustration is
   optional — its absence is never a gate failure.
4. Confirm the demo is genuinely click-through — the next/prev or tab controls exist and their
   JS actually switches the visible step (not just a cosmetic active-class flip with all steps
   rendered stacked underneath).
5. Confirm no external network calls (grep for `http://`/`https://` in `<script src>`,
   `<link href>`, `fetch(`, `@import` — should be none).
6. Confirm the size ceiling was respected for the mode chosen.
7. Spot-check 2-3 sentences in the Mission/Feature sections against `:research`'s notes for
   traceability — flag anything that reads like invented marketing language.

## On failure

- **Content/structure issue** (sections, theme, controls, external calls, size) → loop back to
  `:compose` with the specific gate that failed.
- **Screenshot issue** (missing/broken image, a step that needs re-capturing) → loop back to
  `:capture` for that step specifically, then re-run `:compose` for just the affected step.
- **Illustration issue** (looks like a mockup/screenshot, placed in the wrong section) → loop
  back to `:illustrate` for one more attempt, or drop it entirely and re-run `:compose` without it.
- Never mark the page ready with a known-failing gate "to save time" — a shorter honest page
  beats a complete one that fails its own checklist.

## Output

On all-pass: report the final path, output mode, size, and step count to the user. State clearly
that publishing/uploading/deploying happens **only if explicitly asked next** — this step's job
ends at "ready," not "shipped."

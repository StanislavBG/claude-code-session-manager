---
name: blog-for-project-feature:compose
description: Step 6 of blog-for-project-feature — assemble the finalized copy, the optional companion illustration, and the captured screenshots into one self-contained, portable, click-through HTML page per feature.config.yaml's theme and output conventions.
---

# blog-for-project-feature:compose

## Input
Final Mission & Description text + final Feature Description text (from `:draft-copy`),
captured steps with real images and captions (from `:capture`), the companion illustration or
its omission-reason (from `:illustrate`).

## Steps

1. **Pick output mode** per `feature.config.yaml`: default `single_file` with base64-embedded
   images. Estimate total size first (sum of image bytes after downscale/compression, including
   the companion illustration if present); if it would exceed `single_file_size_ceiling_mb`, use
   the `folder_fallback_layout` instead (html + `screenshots/` dir, relative paths).

2. **Build the page**, self-contained (inline `<style>`/`<script>`, no external CDN/font/JS
   requests — must work fully offline via `file://`), with exactly the three required sections,
   **Click-Through Demo first** — the real screenshots are the most persuasive thing on the page,
   so they lead, above the fold, before any prose:
   - **Click-Through Demo** — the captured steps rendered as a one-step-at-a-time viewer
     (numbered tabs or next/prev buttons — vanilla JS, no framework). Each step's real image
     renders on top, full width within the viewer, with its caption directly below it — image
     first, caption second, never the reverse. Screenshots only — the illustration never appears
     in this section. This section opens the page, immediately above the fold.
   - **Project Mission & Description** — the finalized text from `:draft-copy`, verbatim
   - **Feature Description** — the finalized text from `:draft-copy`, verbatim. If a companion
     illustration exists, place it here as a header/hero image for the section — never inside
     the Click-Through Demo viewer, so it's never confusable with a real screenshot
   - If `:illustrate` reported an omission, skip the hero image silently (it's an optional
     companion, not a required section) — do not note the omission on the page itself

3. **Apply theme tokens** from `feature.config.yaml`'s `theme` block (font stack, colors,
   radius, max width) — keep it minimal and consistent, this is not a place to freelance a new
   visual style per run.

4. **Write the file** to `output.path_template` (or the folder fallback), resolving
   `{feature-slug}` from the confirmed feature name (kebab-case).

5. **If a required section would be empty** (e.g. `:research` flagged a real gap and nothing
   was found), do not silently omit it — render it with an explicit note ("mission statement not
   documented in this project") so `:review` and the reader both see the gap rather than a
   silently thinner page.

## Output

Hand off to `:review`: the path to the composed HTML (or html+folder), the output mode used,
final size, and whether a companion illustration was included.

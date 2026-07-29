---
name: blog-for-project-feature:draft-copy
description: Step 4 of blog-for-project-feature — write the FINAL prose for the Mission and Feature Description sections from research notes + captured steps. This finalized text is what :illustrate reads to generate the companion image, and what :compose drops into the page verbatim.
---

# blog-for-project-feature:draft-copy

## Input
Mission/description + feature description + any flagged gaps (from `:research`), captured
steps with real captions (from `:capture`).

## Steps

1. **Write the final Mission & Description** (2-4 sentences) from `:research`'s notes — tighten
   for the reader of a feature page, but do not add any claim not already in the notes.

2. **Write the final Feature Description** (1-2 short paragraphs) — what it does, why it
   matters, any real constraint — grounded the same way.

3. **Write one "essence" line** (1 sentence, separate from the two sections above): the single
   idea this feature page should leave someone with if they read nothing else. This is not
   rendered directly on the page — it's the brief `:illustrate` uses to generate a companion
   image, so it should be concrete and visual (name the object/action, not an abstract benefit).
   Example: not "streamlines developer workflow" but "a terminal tab holding a live Claude Code
   session, sitting next to its sibling tabs."

4. **Respect `content.tone`** in `feature.config.yaml` (plain, non-salesy, show-don't-tell) —
   same bot-tell blocklist bar as `blog-from-git`.

5. **If `:research` flagged a gap** (no documented mission, etc.), keep that gap explicit here
   rather than papering over it with invented copy — `:compose` renders the gap-note verbatim.

## Output

Hand off to `:illustrate` and `:compose`: final Mission & Description text, final Feature
Description text, the one-sentence essence line, and captured step captions unchanged from
`:capture`.

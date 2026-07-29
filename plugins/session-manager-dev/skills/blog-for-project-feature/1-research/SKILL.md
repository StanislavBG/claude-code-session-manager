---
name: blog-for-project-feature:research
description: Step 1 of blog-for-project-feature — ground the project's mission/description and the confirmed feature's description in real docs and code, before any HTML gets written. Flags gaps explicitly instead of inventing claims.
---

# blog-for-project-feature:research

## Input
Confirmed project + confirmed feature name + justification, from `:select`.

## Steps

1. **Project mission & description.** Pull from the project's own root docs (`README.md`,
   `CLAUDE.md`'s "What this project is" section if it has one, `package.json`/`pyproject.toml`
   description field as a fallback). 2-4 sentences, in the project's own words where possible —
   don't invent a mission statement it doesn't already have.

2. **Feature description.** Locate the actual entry point(s) — route, component, CLI command,
   pipeline — and read enough of the real implementation to describe, in plain language:
   - what it does (user-facing behavior, not implementation detail)
   - why it matters (what it replaces, what it makes possible)
   - any real constraint worth knowing (auth required, feature-flagged, still in beta) — surface
     these rather than smoothing them over

3. **Identify the demo surface.** Note exact URLs/routes, the commands needed to run the app
   locally, any seed data / login required to reach the feature — `:storyboard` and `:capture`
   need this to actually drive the app.

4. **Flag gaps.** If the mission statement doesn't exist, or the feature's purpose isn't
   evident from code/docs, say so explicitly in the output rather than filling it in with
   plausible-sounding marketing language.

## Output

Hand off to `:storyboard`: mission/description (2-4 sentences), feature description (what/why/
constraints), demo surface (routes, run command, any setup needed to reach the feature), and any
flagged gaps.

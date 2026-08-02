---
name: builder:classify-and-bump
description: Step 1 of builder — parse conventional-commit prefixes from the commit list produced by builder:diff and decide the semver bump. Never guess when the history doesn't follow the convention — ask the user instead.
---

# builder:classify-and-bump

Classify every commit subject from `builder:diff`'s output and pick the highest-severity
bump that applies.

## Rules (conventional commits)

- Any commit containing `BREAKING CHANGE:` in its body, or a `!:` right after the type/scope
  (e.g. `feat(api)!:`) → **major**.
- Any `feat:`/`feat(scope):` commit (and no breaking marker above) → **minor**.
- Any `fix:`/`fix(scope):` commit (and nothing higher) → **patch**.
- `chore:`, `docs:`, `refactor:`, `test:`, `ci:` etc. with no `fix`/`feat`/breaking commit
  alongside them → **patch** (matches this project's own convention — see recent history,
  e.g. `chore(release): bump to v0.47.1` following a patch-only commit set).

Take the **highest** bump implied by the whole commit list (one `feat:` among ten `fix:`
commits still means minor; one breaking marker anywhere means major).

## When commits don't follow the convention

If a meaningful fraction of the commit list has no recognizable `type:` prefix at all (not
just an unconventional scope — genuinely no prefix, e.g. a bare "wip" or "updates"), **do
not guess**. Say so explicitly and ask the user which bump to apply, listing the
unclassifiable commits. This mirrors `pr-review-sweep:classify`'s needs-decision carve-out —
guessing wrong here ships an incorrect semver bump that's hard to walk back once published.

## Output

- The bump kind: `patch` | `minor` | `major`.
- The commit list grouped by which rule matched each one (for the eventual report step).
- If ambiguous: the question posed to the user instead of a bump kind, and the pipeline
  pauses here until answered.

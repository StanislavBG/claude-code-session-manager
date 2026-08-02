---
name: builder:report
description: Step 4 of builder — summarize the completed (or stopped) publish run in one report — version bumped, commits covered, npm dist-tag verified, git push confirmed.
---

# builder:report

Produce one concise summary of what happened, whether the pipeline reached publish or
stopped early.

## On a successful publish

Report:
- **Version**: previous → new (and bump kind: patch/minor/major).
- **Commits covered**: the full list from `builder:diff`, grouped by the classification
  `builder:classify-and-bump` assigned.
- **Gate result**: typecheck + test:unit, both PASS.
- **npm verification**: `npm view <packageName> version` and `dist-tags` output, confirming
  the registry matches.
- **Git state**: both `git push origin main` and `git push origin v<version>` confirmed;
  worktree removed.

## On an early stop (no diff, failed gate, ambiguous bump, or a publish-step failure)

Report exactly which step stopped the pipeline and why:
- `builder:diff` — "nothing to publish" (no commits since last release).
- `builder:classify-and-bump` — the question posed to the user, still unanswered.
- `builder:gate` — which command failed and its output.
- `builder:publish` — which numbered step failed, its output, and whether a worktree or
  local tag was left behind that a retry needs to account for.

## Output

One report, plain text, suitable for pasting into an Epic/PRD completion note or relaying
directly to the user — no separate file is written by this step.

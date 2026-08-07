---
name: builder
description: Watch the current project's git history against its published npm package and drive the next publish — diff HEAD against the last release, classify + bump the version from conventional-commit prefixes, gate on typecheck/tests, publish from an isolated git worktree (never the live working directory), keep the paid Field Manual in step with what shipped, then report. Orchestrates 6 nested sub-skills (builder:diff, :classify-and-bump, :gate, :publish, :manual, :report). Use when the user says "/builder", "publish", "release", "cut a release", "bump the version", "ship to npm", "update the manual", or asks whether there's anything unpublished.
---

# builder (orchestrator)

Global, project-agnostic release pipeline — works against whatever npm package the current
project publishes (resolved via `src/main/lib/buildTarget.cjs`'s `resolveBuildTarget()`, or
by reading `package.json` directly if that file isn't present yet). Codified from a real
session that ran this exact sequence 4 times by hand, publishing session-manager
v0.45.1 → v0.47.1 to npm — this skill turns that proven manual procedure into a reusable one.

**Naming convention** (same as `pr-review-sweep` and `issue-address`): sub-skill directories
are prefixed `0-`, `1-`, ... in execution order, so a plain directory listing sorts in DAG
order without opening any file. The invocable `name:` field stays a clean colon-scoped
identifier (`builder:diff`) without the numeric prefix.

## Pipeline DAG

```
┌───────────────────────┐
│ 0. builder:diff            │  HEAD vs. last published version (npm view, else last git tag)
└───────────────────────┘
      │ commit list since last release (empty → stop, nothing to do)
      ▼
┌───────────────────────────┐
│ 1. builder:classify-and-bump   │  conventional-commit prefixes → patch/minor/major
└───────────────────────────┘     (non-conventional history → ask, don't guess)
      │ bump kind decided
      ▼
┌───────────────────────┐
│ 2. builder:gate            │  npm run typecheck + npm run test:unit, both bounded
└───────────────────────┘
   PASS │              │ FAIL
        ▼              ▼
┌───────────────────────┐   STOP — report failing gate, do not publish
│ 3. builder:publish         │  ISOLATED WORKTREE technique (see that step's own file)
└───────────────────────┘
      │ version bumped, tagged, pushed, published, dist-tag verified
      ▼
┌───────────────────────┐
│ 4. builder:manual          │  does the PAID Field Manual still describe reality?
└───────────────────────┘     revise chapters → bump manual version → build bundle
      │ manual release (or an explicit "no content change")
      ▼
┌───────────────────────┐
│ 5. builder:report          │  version, commits covered, dist-tag, manual + push confirmation
└───────────────────────┘
```

| Step | Input | Output | On failure/empty |
|---|---|---|---|
| 0. `builder:diff` | current project cwd | commit list since last published version (or last git tag) | no commits since last release → stop, report "nothing to publish" |
| 1. `builder:classify-and-bump` | commit list | bump kind (`patch`/`minor`/`major`) | commits don't follow conventional-commit style → say so, ask the user rather than guessing |
| 2. `builder:gate` | working tree at HEAD | typecheck + unit test result | either fails → stop, report the failure, do not publish |
| 3. `builder:publish` | bump kind, gate-passed HEAD | published npm package, pushed tag + main | any step fails → stop, report which step and the worktree's state (don't leave it behind uncleaned unless it's evidence of the failure) |
| 4. `builder:manual` | commit list + published version | revised chapters + a built manual release bundle, or an explicit "no content change" | build refuses (missing chapter/asset, bad slug, no free chapter) → stop and report; the npm publish already landed and is unaffected |
| 5. `builder:report` | publish + manual result | one summary: version bumped, commits covered, npm dist-tag verified, git push confirmed, manual edition shipped or explicitly unchanged | n/a |

## Hard rules — read before running any step

- **A dirty working tree in the main repo is NOT a blocker.** The isolated-worktree
  technique in `builder:publish` sidesteps it entirely — `npm ci` + `vite build` +
  `npm publish` all run inside a clean worktree checked out from the just-created tag, never
  touching the live/dirty repo. Don't hold the pipeline waiting for a clean tree; that
  guidance is superseded by this skill.
- **Once a diff is found and the gate passes, run the full sequence through to publish
  without pausing for reconfirmation.** This was confirmed by the user across 4 consecutive
  manual runs in the session that originated this skill — asking "should I publish now?"
  after the gate is green is exactly the friction this skill exists to remove.
- **The gate is a hard stop.** A failing `typecheck` or `test:unit` run means step 3 never
  executes — no publish, no version bump, no tag. Report the failure and stop.
- **The manual is a product, not a changelog.** `builder:manual` may only claim what it has
  verified against real code, and may never invent a screenshot. A wrong instruction in a
  $19.99 paid guide is a refund — treat its accuracy bar as higher than the app's own docs.
  A manual bundle that isn't pushed to the Bilko repo is not shipped; say so plainly.
- **Never guess a version bump from unconventional commit messages.** If the commit list
  doesn't cleanly map to `fix:`/`feat:`/`BREAKING CHANGE:` prefixes, `builder:classify-and-bump`
  asks the user which bump to apply rather than inferring one.

## Why nested skills instead of one inline sequence

Each step is its own file so it shows up as its own invocation in whatever surface tracks
skill/tool calls, and so a step can be changed (a different gate command, a new registry
target) without touching the others — same rationale as `pr-review-sweep` and
`issue-address`.

## What this skill is not

- Not a decision-maker on *whether* to release — it assumes the user (or an Epic) already
  wants the next diff shipped. If there's genuine ambiguity about scope, `builder:classify-and-bump`
  is the one step that pauses to ask.
- Not a registry-agnostic tool — `builder:publish` is npm-specific (see `buildTarget.cjs`'s
  `registry` field for future non-npm targets; out of scope for this version).
- Not wired to any UI button — invoking this skill is the only entry point today.

---
title: Builder skill package — plugins/session-manager-dev/skills/builder/
cwd: /home/bilko/Projects/session-manager
estimateMinutes: 20
sourcePromptId: psess-msase2q4-1
---
# Goal

Create the `builder` skill package at `plugins/session-manager-dev/skills/builder/`, following the exact nested-skill shape already used by `plugins/session-manager-dev/skills/pr-review-sweep/` and `.../issue-address/` (an orchestrator `SKILL.md` plus numbered sub-skill folders, each with its own `SKILL.md`). This encodes, as an invokable `/builder` skill, the git-diff → classify → gate → isolated-worktree-publish → report loop that was run manually 4 times in a prior session (publishing session-manager v0.45.1 → v0.47.1 to npm) — turning a proven manual procedure into a reusable skill.

# Acceptance criteria

- [ ] `plugins/session-manager-dev/skills/builder/SKILL.md` exists as the orchestrator, following the frontmatter + structure of `plugins/session-manager-dev/skills/pr-review-sweep/SKILL.md` (read that file first for the exact shape: description field wording style, how it lists/links its nested sub-skills, its 'Use when' triggers)
- [ ] 5 nested sub-skill folders, each with its own `SKILL.md`: `0-diff/` (compare `HEAD` against `git describe --tags --abbrev=0`; if the app is running, prefer resolving the project's own npm registry state via `npm view <packageName> version` using the package name from `resolveBuildTarget()` in `src/main/lib/buildTarget.cjs`; else fall back to comparing against the last git tag only), `1-classify-and-bump/` (parse conventional-commit prefixes from the commit list: fix→patch, feat→minor, `BREAKING CHANGE:`/`!:`→major; if commits don't follow the convention, say so and ask rather than guess), `2-gate/` (run `npm run typecheck` and `npm run test:unit`, both bounded with `timeout`; a failing gate stops the flow, does not publish), `3-publish/` (the ISOLATED WORKTREE technique — full worked procedure below), `4-report/` (summarize version bumped, commits covered, npm dist-tag verified, git push confirmed)
- [ ] `3-publish/SKILL.md` documents the exact proven procedure, in this order: `npm version <bump> --no-git-tag-version` → `git add package.json package-lock.json` (ONLY those two files, never `-A`) → commit with a message listing the covered commits → `git tag vX.Y.Z` → `git worktree add /tmp/sm-publish-vX.Y.Z vX.Y.Z` → `cd` into that worktree → `npm ci` → typecheck → `npm publish` (its `prepublishOnly` runs `vite build` INSIDE the clean worktree, never touching the live/dirty working directory) → back in the main repo: `git push origin main && git push origin vX.Y.Z` → `git worktree remove /tmp/sm-publish-vX.Y.Z --force` → verify with `npm view <pkg> version dist-tags`
- [ ] SKILL.md explicitly states: a dirty working tree in the main repo is NOT a blocker (the worktree technique sidesteps it entirely) — this supersedes any earlier 'hold and wait for clean tree' guidance
- [ ] SKILL.md explicitly states: once a diff is found and gates pass, run the full sequence through to publish without pausing for reconfirmation — this was confirmed by the user across 4 consecutive manual runs in the session that originated this skill
- [ ] Top-level `SKILL.md`'s frontmatter description is written so it shows up correctly in the skill listing (compare to how `pr-review-sweep`'s description reads in a running session's `<system-reminder>` skill list, if visible in transcripts/logs) — mentions git, npm, publish, version bump, release as trigger keywords
- [ ] `npm run typecheck` passes (skill files are markdown/config, this just confirms nothing else broke)

# Implementation notes

Read `plugins/session-manager-dev/skills/pr-review-sweep/SKILL.md` AND at least one of its nested sub-skill SKILL.md files first, to match the established shape exactly (frontmatter fields, heading structure, how orchestrator references sub-skills, tone). Do not invent a new skill shape. The `session-manager-operations/architecture/build-target.json` config and `src/main/lib/buildTarget.cjs` reader from the `build-tag-and-target-config` PRD in this same Epic should already exist when this PRD runs (no `dependsOn` declared here since this PRD's skill files can be authored referencing that config by its known path even if not yet present — but if it check-fails to find `src/main/lib/buildTarget.cjs`, note it in the report rather than blocking). This session's own manual publish transcript (4 real releases) is the ground truth for `3-publish/SKILL.md` — every command in that acceptance criterion was actually run and verified working, not theoretical.

# Out of scope

- Wiring this skill to the Epic Queue button — separate PRD in this Epic
- Any UI
- Registries other than npm
- Actually running a publish as part of this PRD's own execution

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).

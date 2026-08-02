---
title: Refresh builder agent files to reference build-target config + drop stale dirty-tree caution
cwd: /home/bilko/Projects/session-manager
estimateMinutes: 10
sourcePromptId: psess-msase2q4-1
dependsOn: [build-tag-and-target-config]
---
# Goal

Update the two `builder` agent definition files (`~/.claude/agents/builder.md` global, and this repo's own `.claude/agents/builder.md` project overlay) to reference the new machine-readable `session-manager-operations/architecture/build-target.json` / `src/main/lib/buildTarget.cjs` (from the `build-tag-and-target-config` PRD) instead of duplicating that information in prose, and to reflect what was actually proven across 4 real publishes in the session that created these files: the isolated-`git worktree` publish technique fully solves the dirty-working-tree problem (it is no longer a blocker requiring a pause), and once a diff is found and gates pass, the decide→act sequence should run straight through without re-confirming at each step.

# Acceptance criteria

- [ ] `~/.claude/agents/builder.md`'s step 2 ('Check the working tree before touching anything') is revised: keep the general principle (never stash/discard another session's uncommitted work) but add that the isolated-worktree publish technique (see step 5 / the project overlay) means a dirty tree no longer blocks the release itself — only the build/publish step needs a clean checkout, obtained via `git worktree add <tmp-dir> <tag>` rather than by waiting
- [ ] `~/.claude/agents/builder.md`'s step 5 ('Decide and act') is tightened: remove any residual hedging language about pausing on routine dirty-tree cases specifically (breaking changes / failing gates / first-ever release remain legitimate pause cases — keep those)
- [ ] This repo's `.claude/agents/builder.md` overlay's "Release target" section is rewritten to say: read `session-manager-operations/architecture/build-target.json` (via `src/main/lib/buildTarget.cjs`'s `resolveBuildTarget()` if running inside the app, or by reading the JSON file directly if running as a bare skill/agent) rather than hardcoding the package name and gates inline — keep one short fallback line for what to do if that file is missing (auto-discovery from `package.json`, same logic as `resolveBuildTarget`)
- [ ] The overlay's "Publish sequence (once decided)" section is replaced with a pointer to `plugins/session-manager-dev/skills/builder/3-publish/SKILL.md` (from the `builder-skill-package` PRD in this Epic) rather than re-describing the worktree steps inline — single source of truth, this session's CLAUDE.md convention ("Reference it, don't embed it") for exactly this kind of duplication risk
- [ ] The overlay's "Known one-time exceptions logged here so they aren't re-litigated" section gets one new entry: the 4 real releases from the originating session (v0.45.1, v0.45.2, v0.46.0, v0.47.1) with one line each on what triggered the bump (fix/feat mix) — this is the first real precedent data, replacing the placeholder "(none yet)" line
- [ ] Both files remain valid Claude Code agent-definition markdown (YAML frontmatter with `name`/`description`/`tools` intact, unchanged) — verify by confirming the frontmatter block wasn't accidentally corrupted

# Implementation notes

Both files already exist and were authored by hand during the originating session — read them in full first (`~/.claude/agents/builder.md` and `<this-repo>/.claude/agents/builder.md`) before editing, this is a revision pass, not a from-scratch rewrite. `plugins/session-manager-dev/skills/builder/3-publish/SKILL.md` (referenced in AC #4) is authored by the `builder-skill-package` PRD in this same Epic — if it hasn't landed yet when this PRD runs, point at the intended path anyway (it will exist by the time a human reads this) and note that in your final report rather than blocking.

# Out of scope

- Any code changes — this PRD only touches the two markdown agent-definition files
- Creating new agent files — only revising the two that already exist

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).

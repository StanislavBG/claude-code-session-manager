# Placement reference

Use this to decide where each kind of instruction belongs, and cite the source for every move a review proposes.

## Where each kind belongs

| Kind of instruction | Put it in | Rule and source |
| --- | --- | --- |
| Map, commands Claude must run, critical gotchas | Root CLAUDE.md or AGENTS.md | Loaded every session, so keep it under 200 lines. Hold only pointers, the commands Claude must run and critical gotchas: only what an agent can't find in the code. Sources: memory, large-codebases blog. |
| Both CLAUDE.md and AGENTS.md exist | One file imports the other | Import the shared file with `@path` so one file owns the text. Source: memory. |
| Project structure, file listings and feature tours | A directory pointer, or a command that prints the listing | The code is the source of truth, and a hand-kept tour in CLAUDE.md drifts. Replace the tour with one line naming the directory, or with a command such as `git ls-files <dir>`. This applies to small apps too. Sources: best-practices, large-codebases blog. |
| Conventions for one folder | That folder's CLAUDE.md, or a `.claude/rules` file with `paths:` frontmatter | Folder files load when Claude works there; path-scoped rules load only when matching files are touched. Sources: memory, steering article. |
| Procedures: releases, deploys, review checklists | A skill | A skill loads on demand, so its steps cost nothing until used. Sources: skills best practices, steering article. |
| Rules that must never be broken | A hook or a permission deny rule | CLAUDE.md is guidance Claude may not follow; hooks and deny rules are enforced. A hook can't cover work that runs outside Claude, such as cron scripts, CI jobs or a human's own shell. Guard those separately. Sources: best-practices, steering article. |
| Noisy side research | A subagent that returns a short summary | The subagent reads in its own context and hands back only the conclusion. Sources: best-practices, context-engineering article. |
| Notes for human maintainers | An HTML block comment (`<!-- ... -->`) | Block comments are stripped before the file loads, so they cost no context. Source: memory. |
| Progress records and history | Progress files and git history | Let the next session read them to pick up where the last stopped. Source: long-running harnesses article. |
| Ownership of a doc | One named owner per doc, reviewed every 3-6 months | Assign an owner so the doc is not left to drift. Source: large-codebases blog. |

## Size and load rules

- Imports organize text but don't save context: the imported file loads with its parent.
- Imports go at most four hops deep.
- Imports and symlinks that point outside the repo need a one-time approval.
- Sessions in git worktrees outside the project folder don't load parent-folder CLAUDE.md files, so the map lives inside the repo.
- A doc that a tool returns verbatim (an MCP tool, CLI help, a README shipped in a package) is an entry point too. Treat it like the map.
- SKILL.md stays under 500 lines, with references one level deep from it.
- Reference docs over 100 lines get a contents list.
- Avoid time-sensitive wording; it goes stale without any edit.

## Sources

- https://code.claude.com/docs/en/memory: size under 200 lines, imports (four hops, outside-repo approval), path-scoped rules, HTML comments stripped, worktree loading.
- https://code.claude.com/docs/en/best-practices: keep CLAUDE.md to what Claude can't infer; use hooks for must-happen rules; use subagents for noisy research.
- https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices: SKILL.md under 500 lines, references one level deep, contents list over 100 lines, no time-sensitive wording.
- https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents: load the smallest set of high-signal text; hand side work to subagents that return summaries.
- https://claude.com/blog/how-claude-code-works-in-large-codebases-best-practices-and-where-to-start: root file holds pointers only, assign an owner, review every 3-6 months.
- https://claude.com/resources/articles/steering-claude-code-skills-hooks-rules-subagents-and-more: which mechanism fits which kind of instruction (rules, skills, hooks, subagents).
- https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents: progress records and git history serve as memory across sessions.

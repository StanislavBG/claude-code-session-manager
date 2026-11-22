# Placement reference

Use this to decide where each kind of instruction belongs, and cite the source for every move a review proposes.

## Doc kinds

Every doc is one of five kinds. A kind says how a doc is used, never who owns it.

- **Map.** The root CLAUDE.md or AGENTS.md. It holds one-line rules and links, and it loads every session.
- **Folder notes.** A CLAUDE.md inside a folder. It holds only that folder's facts. It never restates a root rule.
- **Topic docs.** The one doc per topic that holds its full text. Everything else links to it.
- **Agent files.** Personas (subagent definitions), skills, plugin packs (a plugin plus its always-on rules), commands. They load by name. They link to topic docs instead of copying them.
- **History.** Dated reports and logs. They are never edited, and they are never the current answer. A finding that still matters moves into its topic doc.

Rules:

- One topic, one topic doc.
- Code owns every list. A doc names the file or command that holds the list; it does not copy it.
- A rule a check enforces gets one line that names the check.
- Every doc belongs to the project, whoever wrote it. It must read sensibly to the project's owner.

## Where each kind belongs

| Kind of instruction | Put it in | Rule and source |
| --- | --- | --- |
| Map, commands Claude must run, critical gotchas | Root CLAUDE.md or AGENTS.md | Loaded every session, so keep it under 200 lines. Hold only pointers, the commands Claude must run and critical gotchas: only what an agent can't find in the code. Sources: memory, large-codebases blog. |
| Both CLAUDE.md and AGENTS.md exist, at the root or in any folder | AGENTS.md holds the text; CLAUDE.md is a stub that starts with `@AGENTS.md` | The pair rule. Full text: [AGENTS.md and CLAUDE.md](#agentsmd-and-claudemd). Sources: Claude CLI 2.1.325, Codex AGENTS.md guide. |
| Project structure, file listings and feature tours | A directory pointer, or a command that prints the listing | The code is the source of truth, and a hand-kept tour in CLAUDE.md drifts. Replace the tour with one line naming the directory, or with a command such as `git ls-files <dir>`. This applies to small apps too. Sources: best-practices, large-codebases blog. |
| Conventions for one folder | That folder's CLAUDE.md, or a `.claude/rules` file with `paths:` frontmatter | Folder files load when Claude works there; path-scoped rules load only when matching files are touched. Sources: memory, steering article. |
| Procedures: releases, deploys, review checklists | A skill | A skill loads on demand, so its steps cost nothing until used. Sources: skills best practices, steering article. |
| Rules that must never be broken | A hook or a permission deny rule | CLAUDE.md is guidance Claude may not follow; hooks and deny rules are enforced. A hook can't cover work that runs outside Claude, such as cron scripts, CI jobs or a human's own shell. Guard those separately. Sources: best-practices, steering article. |
| Noisy side research | A subagent that returns a short summary | The subagent reads in its own context and hands back only the conclusion. Sources: best-practices, context-engineering article. |
| Notes for human maintainers | An HTML block comment (`<!-- ... -->`) | Block comments are stripped before the file loads, so they cost no context. Source: memory. |
| Progress records and history | Progress files and git history | Let the next session read them to pick up where the last stopped. Source: long-running harnesses article. |
| Maintainer of a doc | One named maintainer per doc, reviewed every 3-6 months | Assign an owner so the doc is not left to drift. Source: large-codebases blog. |

## AGENTS.md and CLAUDE.md

The pair rule:

- AGENTS.md holds every instruction line of its folder. The root AGENTS.md is the entry map.
- A CLAUDE.md beside it starts with the line `@AGENTS.md`.
- Below that line, CLAUDE.md may add only lines true for Claude Code alone. It never repeats a line AGENTS.md already states.
- The same pair rule applies in every scoped folder.
- Size budgets count the pair together: AGENTS.md plus its CLAUDE.md.
- AGENTS.md links with markdown links, not `@`-imports. Codex and other tools do not follow `@`-imports.

Why the stub: verified facts, Claude CLI 2.1.325 (binary and live `claude -p` runs):

- Option `instructionFiles`: `claude-md`, `claude-md-or-agents-md` (default), `claude-md-and-agents-md`, `managed-only`.
- Default mode: a project with only AGENTS.md gets it loaded.
- Default mode: if the project's CLAUDE.md does not import AGENTS.md, AGENTS.md is never seen.
- Default mode: a CLAUDE.md that is just `@AGENTS.md` loads it.
- Nested: in a project with any CLAUDE.md, a nested AGENTS.md alone is never auto-loaded.
- Nested: a nested CLAUDE.md stub (`@AGENTS.md`) beside it loads it when Claude reads that folder.
- CLAUDE.md, `.claude/CLAUDE.md` and CLAUDE.local.md at or above the root all count as "has a CLAUDE.md". A stray CLAUDE.local.md silently turns the AGENTS.md fallback off.
- So the stub makes the pair load in every mode except `managed-only`, and also on older CLIs and in `claude-md` mode.
- In `claude-md-and-agents-md` mode, an imported AGENTS.md is not loaded twice.

Codex facts (developers.openai.com/codex/guides/agents-md):

- Codex reads AGENTS.md, then any `project_doc_fallback_filenames`, once per folder from the git root down to the cwd.
- It reads them at start only, up to `project_doc_max_bytes` (32 KiB by default).
- It does not follow `@`-imports.

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
- https://developers.openai.com/codex/guides/agents-md: how Codex finds and reads AGENTS.md.
- Claude CLI 2.1.325 binary and live `claude -p` runs: the `instructionFiles` modes and the AGENTS.md load behaviour above.

---
name: maintaining-md-network
description: >-
  Reviews, audits or drift-checks a project's CLAUDE.md and wider markdown
  network (CLAUDE.md, AGENTS.md, rules, skills, docs, READMEs, auto memory) so
  agents start from one short entry map and find each fact in exactly one
  place, with nothing stale. Use when the user asks to review, audit, clean up,
  restructure or drift-check a project's CLAUDE.md or docs, or says
  "/maintaining-md-network". Takes a Scope and a Mode (Full review or Drift
  check). Keywords: CLAUDE.md, markdown network, docs audit, drift check, stale docs.
---

# maintaining-md-network

**Goal:** every agent that works on or with this project starts from one short entry map, follows links to a few owner docs, and finds each fact in exactly one place, with nothing stale.

**Inputs from the caller:** *Scope* (a folder, or "the whole project") and *Mode* (Full review or Drift check).

**First turn:** research and report. Change no files until the human approves. Then plan the work with `/develop`.

## Why

Files loaded every session (CLAUDE.md, AGENTS.md, unscoped `.claude/rules`, auto memory) spend attention on every task. Keep each under 200 lines, and keep the root to pointers and critical gotchas. Write down only what an agent can't find in the code. Procedures belong in skills. Conventions for one folder belong in that folder's CLAUDE.md or a path-scoped rule. Never-break rules belong in hooks or permissions. Noisy side research belongs in subagents.

## Time box

When the turn has a wall-clock limit, spend about a sixth on step 1, two fifths on steps 2-4 and a sixth on the report. Use at most 4 read-only subagents, each with one cluster, a 10-minute limit, a 600-word cap and an instruction to write no files at all.

## Steps

1. **Census.** List every instruction or doc file: CLAUDE.md, AGENTS.md and CLAUDE.local.md at every level; `.claude/rules`, skills, agents and commands; `docs/`, READMEs, CONTRIBUTING, ADRs; the project's auto-memory MEMORY.md; any doc an MCP tool or script serves verbatim. Per file record lines, last commit date, tracked or not, and human- or program-written. Report the share of markdown that is machine-written records or runtime state.

2. **Audiences and entry points.** Name the audiences: maintainers, agents in other repos that consume the project (API, MCP server, SDK, published package), operators, end users. For each, say what it loads automatically and where it runs. Sessions in git worktrees outside the project folder don't load parent-folder CLAUDE.md files, and imports from outside the repo need a one-time approval, so the map must live inside the repo.

3. **Links and consumers.** For each doc, find who links to or reads it: other docs, code comments, tests, scripts, CI, other repos, tools that return it. Headings cited by name must not change.

4. **Truth check.** Verify paths, commands, counts, versions, endpoints, prices, schedules and owners against code and config, citing `file:line`. Flag every hand-kept list that copies a source of truth.

5. **Report.** Include:
   - The proposed network: one map of at most 70 lines, one entry point per audience, the fewest owner docs. Reference docs over 100 lines get a contents list. Links are one level deep from the map.
   - A one-owner table for every fact that appears in more than one doc.
   - A verdict per doc: KEEP-OWNER, MERGE-INTO `<doc>`, SHRINK-TO-POINTER, MOVE-TO-OWNING-REPO, or DELETE. Delete only when no live link points to it, no program reads it, and its content is obsolete or owned elsewhere.
   - What moves into skills, path-scoped rules, hooks or subagents.
   - Records and runtime state. Never delete state a program reads.
   - Wrong claims and bugs found.
   - A maintenance plan: one drift-check script for broken links, missing paths and size budgets of always-loaded files, run on a schedule or in CI, plus a review every 3-6 months and after each major model release.
   - At most 4 decisions that would cost rework if guessed wrong.

   In **Drift check** mode, do steps 1, 3 and 4 only, and only for files changed since the last review record.

6. **After approval, plan with `/develop`** in this order:
   1. Delete obsolete docs.
   2. One PRD per owner doc, each moving its facts and removing them from the entry files in the same commit.
   3. Rewrite the map and entry files (depends on all of the previous step).
   4. Change any tool that serves docs.
   5. Validate.

   Links must resolve for every audience; tools that return text verbatim need repo-root paths. Commit a dated review record under `session-manager-operations/reviews/docs/` (or the project's own reviews folder) as the next drift check's baseline.

7. **Cross-repo findings.** Findings that belong to another repo go through `/send-feedback`; run `feedback_list_projects` first. For repos not on that list, state the facts and paths in the report.

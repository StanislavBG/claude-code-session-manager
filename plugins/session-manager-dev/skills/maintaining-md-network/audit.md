# Audit reference (steps 1-4)

## Contents

- [Time box](#time-box)
- [1. Census](#1-census)
- [2. Audiences and entry points](#2-audiences-and-entry-points)
- [3. Links and consumers](#3-links-and-consumers)
- [4. Truth check](#4-truth-check)
- [Subagent brief](#subagent-brief)

Use this file for the research half of a review. It lets the whole audit fit inside one 30-minute headless turn. Change no files while auditing.

## Time box

In a turn that is killed at 30 minutes:

| Phase | Budget |
| --- | --- |
| Step 1, census | at most 5 minutes |
| Steps 2-4, audiences, links, truth check | at most 12 minutes |
| Report | 5 minutes |

The rest is slack. Do not spend it. Start the report at minute 17 at the latest, with whatever you have, and mark unfinished checks as "not checked".

Use at most 4 read-only subagents, one per cluster of files. Start them in the same message so they run in parallel. Paste the [Subagent brief](#subagent-brief) into each prompt.

Two lessons from the first hand-run review:

- Without a time box, audit subagents took 11-17 minutes each. That is why every brief carries a 10-minute limit and a 600-word cap.
- One "read-only" subagent still wrote a scratch file. Saying "read-only" is not enough. The brief must say "write no files at all, not even scratch files". After the subagents return, run `git status --short` and delete anything you did not create.

## 1. Census

List every instruction or doc file. Count each kind:

- `CLAUDE.md`, `AGENTS.md` and `CLAUDE.local.md` at every level of the tree.
- `.claude` rules, skills, agents and commands.
- `docs/`, READMEs, CONTRIBUTING and ADRs.
- The project's auto-memory `MEMORY.md`.
- Any doc a tool or script returns verbatim.

Start with the tracked files, then add the untracked ones:

```
git ls-files -- '*.md'
git ls-files --others --exclude-standard -- '*.md'
git ls-files --others --ignored --exclude-standard -- '*.md'
```

Record these fields for each file:

| Field | Command |
| --- | --- |
| Lines | `wc -l < <file>` |
| Last commit date | `git log -1 --format=%cs -- <file>` |
| Tracked or not | `git ls-files --error-unmatch -- <file>` (exit 0 = tracked); `git check-ignore -v <file>` shows the ignore rule |
| Human or program written | `git log --format=%an -- <file>` for the authors; a bot or script author, a generated-file header, or a script that writes the path means program |

Do the lines and dates in one pass over the file list, not one command per file by hand. Find the writer of a suspect file with `git grep -n "<file name>" -- '*.js' '*.cjs' '*.ts' '*.py' '*.sh'`.

Then report the share of markdown that is machine-written records or runtime state: files and lines of that kind, divided by all markdown files and lines. Records and state are not docs. Keep them out of the owner-doc plan, and never propose deleting state that a program reads.

## 2. Audiences and entry points

Name each audience that reads this project's markdown, and for each one write down what it loads automatically and where it runs:

- **Maintainers.** They open the repo and work in it. They load the root and nested `CLAUDE.md` files, `AGENTS.md`, unscoped rules and auto memory. Check which of these a session in a git worktree outside the project folder still loads. Parent-folder `CLAUDE.md` files are not loaded there, so the map must live inside the repo.
- **Agents in other repos that consume the project.** They use its API, MCP server, SDK or published package. They load their own repo's files and read only what the package ships or a tool returns. Check the package's file list (`files` in `package.json`, `.npmignore`, the published tarball) to see which docs reach them.
- **Operators.** They deploy and run it, on servers or schedulers. They read runbooks, READMEs and config comments, and often run where no repo checkout exists.
- **End users.** They see the product docs, help text and web pages, and nothing else.

A doc that a tool, script or endpoint returns verbatim is an **entry point**, even when no human opens it as a file. For each one:

1. Record its size in lines.
2. If it is over 100 lines, give it a contents list.
3. Write its links as repo-root paths. A relative link breaks when the text is read away from its folder.
4. Find the code that serves it, and note whether that code reads headings by name.

Imports from outside the repo need a one-time approval, so do not point an entry map at files outside the repo.

## 3. Links and consumers

For each doc, find everything that links to it or reads it. Search for the file name, its repo-root path and its title:

```
git grep -n -e "<file name>" -e "<path>"
```

Cover each place a reference can live:

- Other docs (links, "see X" prose, tables of contents).
- Code comments and string constants.
- Tests, including fixtures and snapshots that read a doc.
- Scripts, build files and CI workflows.
- Other repos and tools: package manifests, installers, MCP tools and endpoints that return the text.

Record the consumer kinds for each doc. A doc with no consumer and no live link is a candidate for deletion. A doc a program reads is not.

**Headings cited by name must not change.** Search for every `#anchor` and every quoted heading, in docs, code and tests. When a consumer cites a heading, keep the heading text exactly, or change the citation in the same commit.

Run the link check once over the whole tree, so you do not check links by hand: use the project's drift-check script if it has one.

## 4. Truth check

Verify each claim in the docs against code and config. Cite `file:line` for every finding, both the doc line and the line that proves or disproves it. Check these kinds of claim:

- **Paths.** Does the file or folder exist, and is it spelled right?
- **Commands.** Does the script exist in `package.json`, a Makefile or a task runner? Do the flags exist?
- **Counts.** "12 endpoints", "7 tags", "4 hooks": count them in code.
- **Versions.** Runtime, framework and package versions against the manifest and lockfile.
- **Endpoints.** Routes, methods and ports against the route table or server code.
- **Prices.** Plan names and amounts against billing config and the pricing page source.
- **Schedules.** Cron lines, intervals and retention periods against the scheduler config.
- **Owners.** Teams, names and contact points against `CODEOWNERS`, the manifest and the host config.

Also flag these, even when every fact is true today:

1. **Every hand-kept list that copies a source of truth**: a registry, `package.json`, a route table, a directory listing, an enum. The list will drift. Replace it with a pointer to the source, or with a command that prints the list.
2. **Instructions written for an older model's limits**: "remember to...", "always double-check...", step-by-step hand-holding, or all-caps warnings that a current model does not need.
3. **Time-sensitive wording**: "currently", "as of", "new", "recently", "we plan to", dates, and "v1 only". History belongs in git, not in docs. Reword to the present tense, or delete.

## Subagent brief

Copy this template into each subagent prompt. Fill in the cluster and the question list. Do not shorten the limits.

```
You are auditing one cluster of a project's markdown files. Read only.

Cluster: <name the cluster: a folder, or a list of files>

For each file in the cluster, report:
1. Lines, last commit date, tracked or not, human- or program-written.
2. Who links to it or reads it (docs, code, tests, scripts, CI, other repos, tools).
3. Claims that are wrong, checked against code and config. Cite file:line.
4. Hand-kept lists that copy a source of truth, instructions written for an
   older model's limits, and time-sensitive wording.

Rules:
- Limit: 10 minutes. Stop at 10 minutes and report what you have.
- Cap: 600 words. Use a terse list, one line per finding.
- Write no files at all, not even scratch files. Do not edit, move or delete
  anything. Run read-only commands only.
- Cite file:line for every finding. If you did not check something, say
  "not checked".
```

# Planning reference

Use this after the audit steps. It sets what the review report must contain, how to give each doc a verdict, the order `/develop` queues the restructure in, and how to route findings for other repos. Change no files until the human approves the report.

## Contents

- [Report](#report)
- [Verdicts](#verdicts)
- [Records and runtime state](#records-and-runtime-state)
- [After approval](#after-approval)
- [Other repos](#other-repos)

## Report

Write one report. Include every item below.

1. **The proposed network.**
   - One map of at most 70 lines.
   - One entry point per audience.
   - The fewest owner docs that cover the rest.
   - A contents list on every reference doc over 100 lines.
   - Links one level deep from the map: the map links to an owner doc, and the owner doc does not need another hop to answer the question.
2. **A one-owner table.** Add a row for every fact that appears in more than one doc. Give the owning doc, the docs that must lose the fact, and the single term used for the concept. Use one term per concept across the whole network.
3. **What moves out of the always-loaded files.** Name each item and its destination: a skill, a path-scoped rule, a hook, a permission rule or a subagent.
4. **Wrong claims and bugs.** List each claim that would mislead an agent, with the evidence as `file:line`. List bugs found in code, config or scripts while checking.
5. **A maintenance plan.**
   - The drift-check script, run on a schedule or in CI.
   - A named owner and a last-review date in the map's maintainer comment.
   - A review every 3-6 months and after each major model release.
6. **Decisions.** Ask at most 4 decisions that would cost rework if guessed wrong. Decide everything else and say what you chose.

## Verdicts

Give every doc exactly one verdict.

| Verdict | Meaning |
| --- | --- |
| KEEP-OWNER | The doc is the single owner of its facts. Keep it and trim copies of other docs' facts out of it. |
| MERGE-INTO `<doc>` | The doc's facts belong in another owner doc. Move them there, then remove the doc and repoint every link. |
| SHRINK-TO-POINTER | Reduce the doc to a few lines that point to the owner. Use this when a link, a heading cited by name or a program still needs the path. |
| MOVE-TO-OWNING-REPO | The facts belong to another repo. Hand them over as described in Other repos. |
| DELETE | Remove the doc. Allowed only under the rule below. |

DELETE is allowed only when all three hold:

- No live link points to the doc.
- No program reads it: no script, test, CI job, hook or tool that serves docs verbatim.
- Its content is obsolete or owned elsewhere.

Git history keeps everything else. When any one of the three fails, choose SHRINK-TO-POINTER or MERGE-INTO instead.

## Records and runtime state

Some markdown is written by a program: logs, queue records, generated reports, state files. Count it in the census, and report its share of all markdown.

- Never delete state a program reads.
- Leave untracking to the tool that owns it. Do not run `git rm --cached` or edit ignore rules for files another tool writes. Name the owner and the finding in the report.
- Keep machine-written files out of the map and out of the owner docs.

## After approval

Plan the work with `/develop`, in this order:

1. **Delete obsolete docs.** Only docs with the DELETE verdict.
2. **One PRD per owner doc.** Each PRD moves that doc's facts into it and removes the same facts from the entry files in the same commit.
3. **Rewrite the map and entry files.** This PRD depends on all of step 2.
4. **Change any tool that serves docs.** Add the drift-check script as a gate or CI step.
5. **Validate.** Re-run the drift-check script and record the flags you used in the review record. Run `git grep -n -F -e "<old name>" -e "<old path>"` with no file-type filter for every deleted or renamed doc, so code strings, scripts and tool descriptions are covered, not only markdown links. Open each audience's entry point to confirm it reaches its owner docs.

Links must resolve for every audience. Tools that return text verbatim need repo-root paths. Commit a dated review record in the format drift-check.md defines, as the next drift check's baseline.

## Other repos

A finding that belongs to another repo goes through `/send-feedback`. Run `feedback_list_projects` first and send only to a project on that list. For a repo that is not on the list, the report states the facts and the paths, so a human can carry them over.

Two lessons from earlier reviews:

- Feedback to 5 sibling repos failed because they were not Session Manager projects. Check the list before sending.
- A map in a parent folder never loads in worktree sessions. Put each map inside the repo it serves.

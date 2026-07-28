---
name: issue-address
description: Take ONE GitHub issue on the current project's repo from selection (or a named issue number) to a verified, reviewed fix — orchestrates 6 nested sub-skills (issue-address:select, :confirm-open, :claim, :reproduce, :fix, :verify) plus the existing requesting-code-review skill, so each step is independently invokable and monitorable. Use when the user wants a real issue picked and actually resolved, not just triaged.
---

# issue-address (orchestrator)

Global, project-agnostic issue-to-fix pipeline — works against whatever repo the current
project's `gh` remote points to. Fires exactly one issue through a fixed sequence of nested
skills — each a real, independently-invokable `SKILL.md`, not just a section header, so the
sequence's progress can be watched step by step instead of as one opaque pass. Codified from
`midt-bg/sigma`'s workflow; a project's own `AGENTS.md`/`CLAUDE.local.md` may add repo-specific
conventions (branch naming, claim-comment language, commit style) that this skill should read
and respect if present.

**Naming convention (see a project's own `AGENTS.md` if it documents one; otherwise this
convention still applies as the plugin's own standard):** sub-skill directories are prefixed
`0-`, `1-`, `2-`... in execution order, so a plain directory listing sorts in DAG order
without needing to open any file. Never rely on prose order alone — a reader (or an
alphabetically-sorted file browser) should see the sequence from the folder names
themselves. The invocable `name:` field stays a clean colon-scoped identifier
(`issue-address:select`) without the numeric prefix — the prefix is a filesystem/ordering
aid, not part of the skill's name.

## Pipeline DAG

```
                    ┌─────────────────────┐
  no issue #  ──────▶ 0. issue-address:select │──▶ issue number
                    └─────────────────────┘         │
  issue # given ─────────────────────────────────────┘
                                                      ▼
                                        ┌───────────────────────────┐
                                        │ 1. issue-address:confirm-open │
                                        └───────────────────────────┘
                                     GO │                    │ NO-GO
                                        ▼                    ▼
                          ┌─────────────────────┐    STOP — report why
                          │ 2. issue-address:claim   │
                          └─────────────────────┘
                    claimed │              │ claim failed to land
                             ▼              ▼
                  ┌─────────────────────┐    STOP — report (don't proceed
                  │ 3. issue-address:reproduce│    unclaimed)
                  └─────────────────────┘
                    reproduces │              │ doesn't reproduce
                                ▼              ▼
                  ┌─────────────────┐   STOP — report (valid outcome,
                  │ 4. issue-address:fix │    not a failure)
                  └─────────────────┘
                                │
                                ▼
                  ┌────────────────────┐
                  │ 5. issue-address:verify│──── red ────┐
                  └────────────────────┘                 │
                                │ green                   │
                                ▼                          │
                  ┌────────────────────┐                  │
                  │ 6. requesting-code-review│             │
                  └────────────────────┘                  │
                                │                          │
                                ▼                          ▼
                       land per conventions      loop back to step 4
```

| Step | Input | Output | On failure |
|---|---|---|---|
| 0. `issue-address:select` | open-issue pool (implicit — repo-wide) | one issue number + justification | n/a (always produces one, or explicitly reports the pool is empty) |
| 1. `issue-address:confirm-open` | one issue number | GO (+ title/body/repro steps) or NO-GO (+ reason) | **STOP** — do not proceed |
| 2. `issue-address:claim` | one confirmed-open issue number | self-assignment + claim comment, re-confirmed as landed | **STOP** — report if the claim didn't actually post; don't proceed unclaimed |
| 3. `issue-address:reproduce` | issue title/body/repro steps | failing test (file:line) + root-cause hypothesis + red-phase output | **STOP** — report "does not reproduce" (valid, not a failure) |
| 4. `issue-address:fix` | failing test + root-cause hypothesis | diff + the one test now green | loops internally until its one test is green |
| 5. `issue-address:verify` | diff + green reproduction test | full-suite pass counts + typecheck result | **loop back to step 4** — do not proceed to review on red |
| 6. `requesting-code-review` | the verified diff | Critical/Important findings addressed | fix findings, do not mark resolved until clean |

Called either with **no issue number** (enters at step 0) or with **one specific issue
number already named** (enters at step 1, skipping step 0 entirely).

**Why claim is its own step, not folded into confirm-open:** confirming an issue is
open/unclaimed and actually claiming it are two different moments in time — a gap where a
second concurrent run (or a human) could pick the same issue between the two. `select`'s
`reject-claimed` check only catches claims that already exist (an assignee, a "working on
this" comment); nothing marks the issue claimed *for this run* until `claim` actually
posts one. No dedicated GitHub/issue-tracking MCP server is connected in this environment
— `claim` uses the `gh` CLI directly (self-assign + comment), same as every other GitHub
interaction in this skill chain.

## After the sequence completes clean

- Commit with a conventional-commit message (`fix(scope): subject`, no trailing period, no
  `Co-Authored-By` trailer unless the project's own convention says otherwise), on a branch
  following the project's own `<type>/<slug>` convention if it documents one.
- **Only push / open a PR when explicitly asked** — per the project's own `AGENTS.md` PR
  section if it has one, don't do it unprompted. Report the sequence as complete and ready,
  and wait.
- If a PR does get opened (once asked), post a short comment on the originating issue
  linking it — closes the loop from report to fix.
- Never contact a reviewer (no request/re-request/nudge) without the user's fresh,
  explicit, per-instance approval — same hard constant as everywhere else in this workflow.

## Why nested skills instead of one inline sequence

Each step is its own file so it shows up as its own invocation in whatever surface tracks
skill/tool calls — you can see "select ran, chose #N over 4 rejected candidates" and
"confirm-open ran, returned GO" as distinct, inspectable events before "reproduce" even
starts, rather than one long undifferentiated pass. If a step needs to change (e.g. the
verify step's test-runner command, or select's ranking weights), it's a one-file edit that
doesn't touch the others. When a step needs more depth or clarity, decompose it further
the same way `issue-address:select` was (see `0-select/SKILL.md` for its own nested DAG)
— continuously, wherever a single file is doing too much to inspect as one unit.

## What this skill is not

- Not a pure triage/backlog tool — that's `find-opportunity` (ranks what to work on next
  without opening/fixing anything, and never opens/fixes on its own). `issue-address:select`
  overlaps with it in spirit (both rank by impact and check for claims) but exists
  specifically to feed straight into actually fixing one issue in the same run, not just
  to produce a shortlist for a human to review.
- Not for PR review comments — that's a different data source entirely (see
  `pr-review-sweep` for the unresolved-review-thread workflow on already-open PRs).

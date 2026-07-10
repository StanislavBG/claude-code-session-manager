---
name: find-opportunity
description: >-
  Triage a shared repo's open issues against open PRs and main to produce a ranked
  shortlist of what to work on next, PLUS an explicit, reasoned skip-list of what NOT to
  pick (already claimed by a PR — even one only referenced via the PR's title, not a
  "Closes #" line — or would conflict with an open PR's diff, or is blocked/needs-decision).
  Recommendation only; the human picks. Never opens or files anything. Use whenever the
  user says "/find-opportunity", "what should I work on next", "pick the next issue", or
  wants a ranked backlog triage for a repo with multiple contributors/open PRs. Keywords:
  triage, backlog, next issue, opportunity, ranked shortlist, skip list, PR conflict,
  issue claimed.
---

# /find-opportunity — rank what to work on next, and say what NOT to touch

**Role:** the *triage* front-half of a "work the backlog well" loop
(`find-opportunity → develop → repeat`). It answers "what should I pick up next in this
repo" for a shared/multi-contributor project where picking wrong (a duplicate, a merge
fight) wastes real work. It never implements — that's `/develop`'s job once a human
approves a pick.

**The skip-list is the point, not a footnote.** Knowing what *not* to pick is as
important as ranking what to pick. Every skip gets a reason and, where applicable, the
blocking PR number — never a silent omission.

## Procedure

1. **Gather.** For the target repo (current cwd unless the user names another):
   - Open issues: `gh issue list --state open --json number,title,labels,assignees,body`
     (or the project's own issue tracker if it doesn't use GitHub issues — ask if unclear).
   - Open PRs: `gh pr list --state open --json number,title,body,headRefName,files`.
   - `main`'s current state (`git log --oneline -20`, `git status`) for recency context.

2. **Claim-match each issue against open PRs — match aggressively, not just `Closes #`.**
   An issue is CLAIMED when any of these link it to an open PR:
   - The PR body has `Closes #N` / `Fixes #N` / `Resolves #N` (the obvious case).
   - The PR **title** references the issue number (`(#N)`, `#N:`, etc.) — don't rely on
     body-only scanning; a title-only reference is real and easy to miss with a naive
     `Closes #` grep.
   - The PR's branch name encodes the issue number or a close paraphrase of its title.
   - A linked-PR field the tracker itself exposes (GitHub's "Development" issue↔PR link,
     if the API surfaces it).

3. **Conflict-match each remaining issue against open PRs' diffs.** For an issue not
   already claimed, check whether fixing it would likely touch files an open PR is
   actively rewriting (`gh pr list --json files` per PR, cross-referenced against the
   issue's likely target files — infer from the issue body/title, or a quick grep for the
   feature area named). High churn overlap on shared/hot files (a core module, a global
   stylesheet several PRs touch) → SKIP or DEFER. Cold files (isolated tests, an
   untouched route) → safe to proceed even if some other PR is open elsewhere in the repo.

4. **Skip anything blocked or owned.** `status: needs-decision`, an assignee already set,
   or a "discussion"/"blocked" label → SKIP, not ranked. Not actionable solo.

5. **Rank what survives** by impact ÷ conflict-risk. Impact from priority/severity labels,
   blast radius (how many surfaces/users it affects), and staleness (an old high-severity
   bug outranks a new low one). Conflict-risk from step 3's file-overlap check (even a
   non-blocking overlap lowers rank — prefer the fully-cold pick when impact is close).

6. **Report both lists, every entry reasoned:**
   - **Shortlist** (ranked): issue #, title, one-line reasoning (why this rank), impact
     signal, conflict-risk signal.
   - **Skip list** (unranked, exhaustive over everything considered): issue #, title,
     reason (claimed by PR #N via <title/body/branch> / conflicts with PR #M's diff on
     `<file>` / blocked-status / needs-decision / assignee set). Never drop an item
     silently — if it was considered, it's in one list or the other.

7. **Recommend, don't act.** End with the top pick and why, but the human chooses. Do not
   open an issue, start work, or file a PR from this skill — that's `/develop`'s job,
   invoked separately once a pick is approved.

## Notes

- This skill only *reads* the tracker (issues/PRs) and git state — it makes no commits,
  opens nothing, and files nothing. If the loop surfaces a genuine follow-up that can't be
  picked now, note it in the report; do not auto-file a new issue or `/my-feedback` item
  for it. Filing anything public/outward is a human decision, not this skill's default.
- Don't rank an item you couldn't verify is actually unclaimed and non-conflicting — when
  in doubt, put it in the skip list with the uncertainty stated, rather than ranking a
  risky guess highly.
- Standalone-useful on its own (triage without ever running `quality: high` on the pick) —
  don't assume this skill is only ever the front-half of a longer loop.

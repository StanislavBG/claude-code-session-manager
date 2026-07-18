---
title: "needs_review" verdict fires as a false positive when a PRD's target work was already completed by an out-of-band agent before the scheduler ran it
source: bilko (sigma project session, 2026-07-18)
type: bug
severity: normal
---

# What happens / what's missing

In the sigma project (`~/Projects/sigma`), I queued 11 PRDs (562-572) for the scheduler and,
because the scheduler processes at very low concurrency (0-2 jobs running at a time across
many projects sharing the queue) and there was a lot of backlogged work, I also directly
launched isolated-worktree agents to execute several of the same PRDs' acceptance criteria
myself, in parallel with the scheduler picking them up on its own schedule.

Result: for at least 5 of these PRDs, the scheduler's own execution started or ran *after* my
out-of-band agent had already completed the work (merged main, verified, pushed). The
scheduler's run correctly found nothing left to do — the target state was already reached — but
its verifier flagged this as suspicious and landed the job in `needs_review` instead of
`completed`, with the same templated message every time:

```
SCHEDULER_VERDICT: PASS but no commit landed during the run window — the run claims success but
produced no code change
```

This is a false positive. The run's own conclusion ("no code change needed, target state already
met") was correct — the verdict-classifier's heuristic ("PASS + zero diff => suspicious, needs
human review") doesn't account for "another actor already satisfied this PRD's acceptance
criteria before this run started," which is a real and unavoidable outcome once anything other
than the scheduler itself (a human, an out-of-band agent, a differently-scheduled job) can also
act on the same target (a git branch, a PR, a file). It's not unique to my workflow — any
external actor touching the same target between PRD authoring and PRD execution reproduces this.

# Evidence

Five sigma jobs hit this exact pattern with the identical error string:

- `565-pr188-merge-main` — needs_review, error: `SCHEDULER_VERDICT: PASS but no commit landed during the run window — the run claims success but produced no code change`
- `567-pr171-merge-main` — same error
- `568-pr170-merge-main` — same error
- `562-pr206-merge-main` — same error, `exitCode: 0`, `verifierVerdict: "pass_no_commit"`, `autoFixAttempted: true`
- `569-pr169-merge-main` / `571-pr141-merge-main` — same error (still `needs_review` as of this writing; I archived their PRD source files to `prds-archived/` since I independently confirmed via `gh pr view <n> --json mergeable,mergeStateStatus` and `gh pr checks <n>` that all target PRs were genuinely `MERGEABLE` with CI passing — the real-world target state was correct, only the queue's status label was stale)

`~/.claude/session-manager/scheduled-plans/queue.json` job record for `562-pr206-merge-main` (illustrative):
```json
{
  "slug": "562-pr206-merge-main",
  "status": "needs_review",
  "runId": "2026-07-18T20-14-44-627Z",
  "startedAt": "2026-07-18T20:14:44.631Z",
  "finishedAt": "2026-07-18T20:15:57.286Z",
  "exitCode": 0,
  "error": "SCHEDULER_VERDICT: PASS but no commit landed during the run window — the run claims success but produced no code change",
  "transientRetries": 2,
  "verifierVerdict": "pass_no_commit",
  "autoFixAttempted": true
}
```
My out-of-band agent had already pushed PR #206's merge commit (`828fab8`) roughly 4 minutes
before this scheduler run started (`startedAt: 20:14:44`), so the scheduler's own run correctly
found the branch already `MERGEABLE` and made no commit — that's the expected, correct outcome
given the target was already satisfied, not a failure.

# Suggested direction (two related but separable asks)

1. **Soften the `pass_no_commit` verdict when the PRD's own stated postcondition is independently
   verifiable and already true.** For a PRD whose acceptance criteria are checkable via an
   external command (e.g. `gh pr view <n> --json mergeable,mergeStateStatus` reporting
   `MERGEABLE`, or a `git diff origin/main..<branch>` being empty), the runner could re-check that
   postcondition itself before classifying "PASS + no commit" as suspicious — if the postcondition
   already holds, classify as `completed` (with a note: "target state already satisfied, no
   action taken"), not `needs_review`. This wouldn't cover every PRD shape, but merge/sync-style
   PRDs (a recurring pattern here — see the `NN-prXXX-merge-main` naming convention already used
   dozens of times in this queue) are exactly the case where this false positive recurs, and
   they're mechanically checkable.
2. **Give the scheduler (or its operator) a documented, safe way to mark a `needs_review` job as
   resolved-externally**, distinct from re-running it. Right now the only remediation I could find
   was archiving the PRD's source `.md` file from `prds/` to `prds-archived/` (an established
   convention already used elsewhere in this repo, e.g. `prds-archived/338-*.md`,
   `prds-archived/439-*.md.duplicate-of-425`) — but that doesn't touch the job's `status` field in
   `queue.json` itself, which stays `needs_review` indefinitely. I deliberately did not hand-edit
   `queue.json` directly to flip the status, since it's a live file the running Electron scheduler
   process owns and a manual edit risks a torn write racing the app's own save cycle. A small,
   safe surface (a CLI flag, an MCP tool, or even just documented guidance on the accepted
   `prds-archived/` convention plus what if anything to do about the matching `queue.json` entry)
   would close this gap.

This surfaced because I was intentionally working around the scheduler's low concurrency by
doing some of its queued work myself in parallel — a reasonable thing for an operator to do when
there's a large backlog and multiple projects sharing one scheduler, so this isn't a one-off edge
case; it'll recur any time a human or another agent races the scheduler to the same target.

## RESOLUTION

Both asks confirmed against current code and actioned.

**Ask 1 (soften `pass_no_commit` for an independently-checkable postcondition):** confirmed the
gap is real — `runVerify.cjs`'s `pass_no_commit` check (~line 645) only exempts fix-plan jobs
(`^\d+-fix-`); `scheduler.cjs`'s `RESCANNABLE_VERDICTS` doc comment explicitly notes rescanning
`pass_no_commit` is a harmless no-op for non-fix-plan slugs, i.e. the `-merge-main` cases cited
here get no relief from the existing rescan path. Queued
`575-verifier-merge-postcondition-exemption` (cwd `~/Projects/session-manager`): adds a narrow
exemption for `-merge-main`-slugged PRDs that independently re-checks `gh pr view <n> --json
mergeable,mergeStateStatus` before flagging `pass_no_commit`, with a strict timeout and a
fail-safe fallback to today's behavior on any `gh` error (never a new failure mode, only ever a
strict improvement). Scoped narrowly to the one evidenced case, not a general postcondition
framework.

**Ask 2 (safe way to resolve a stale `needs_review`/`failed` job without hand-editing
`queue.json`):** this already exists — `queueOps.cjs`'s exported `archiveMany([slug])` does an
atomic, path-contained rename of the PRD's source `.md` to `prds-archived/<ISO>/`, and
`scheduler.cjs`'s `reconcile()` (which runs on every queue read/tick) drops any `queue.json` job
entry whose PRD file no longer exists — so archiving the file is sufficient, no `queue.json`
write required, ever. Confirmed working live, twice, in the same session this feedback was
processed in: `561-fix-fix-global-chrome-frame-review` (a `failed` job superseded by a sibling
that already completed the same close-out) and the redundant `565-terminal-review-fix` /
`565-fix-terminal-review-fix` pair (duplicate of already-completed, already-verified work) were
both archived this way and cleared from `queue.json` within one scheduler tick (~15s observed),
with zero direct file edits. Documented as a new §15 in
`~/.claude/session-manager/scheduled-plans/PRD_AUTHORING.md` ("Resolving a `failed`/`needs_review`
job whose target work is already done") so this doesn't need rediscovering — no code change
needed for this half.

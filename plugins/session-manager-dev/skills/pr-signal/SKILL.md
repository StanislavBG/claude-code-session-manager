---
name: pr-signal
description: >-
  Request or re-request a reviewer on one PR on the current project's repo — the ONLY
  step in the PR flow that contacts a person. Deliberately separate from pr-review-sweep
  and meant to be invoked rarely — most projects don't tag reviewers often. Requires the
  user's explicit, fresh, per-PR approval every time — a prior approval never carries
  forward, and CI must be green at the moment of signaling, not just when approval was
  given. Use only when the user explicitly names a PR number and says to
  request/ping/notify the reviewer, or approves signaling in response to a
  pr-review-sweep report.
---

# pr-signal — the one step that contacts a reviewer (rare, gated)

Global, project-agnostic — works against whatever repo the current project's `gh` remote
points to. Input: a PR whose queued PRDs have all landed and whose threads
`pr-review-sweep:land-and-resolve` has replied to and resolved (CI green) — plus the user's
explicit approval for this specific PR number, given in this conversation, not inherited
from an earlier one. If the project has its own reviewer-contact policy doc (e.g. sigma's
`docs/pr-review-workflow.local.md`), read it for repo-specific nuance — reviewer identity,
cadence norms — but the approval-per-PR and CI-green-at-signal-time gates below are hard
constants regardless of what a project's doc says.

**This skill runs far less often than the rest of the flow.** Most PRs on this repo don't need
an explicit re-request — a push alone re-triggers review for an already-requested reviewer, and
this team doesn't like being tagged unnecessarily. Only invoke this when the user actually asks
for it, by PR number.

## Steps

1. **Verify the gate, don't assume it from a report given earlier in the conversation:**
   - The PR is still open (`gh pr view <n> --json state,mergedAt`) — a merged/closed PR gets
     no signal; report the state change instead.
   - Every review thread is resolved (re-check now via GraphQL `reviewThreads.isResolved` — a
     `pr-review-sweep:land-and-resolve` report from even a few minutes ago can be stale if
     anything else touched the PR, and a new comment that arrived since means the PR goes back
     through `pr-review-sweep:classify`, not to a signal).
   - CI is green **right now** — re-run `gh pr checks <n> --repo "$(gh repo view --json nameWithOwner -q .nameWithOwner)"` immediately
     before acting. An approval given while CI was green does not survive CI going red in
     between (a later push, a flaky rerun). If CI is red at signal-time, stop and report it —
     never signal on a stale approval, and never solicit approval on a PR that's currently
     CI-red in the first place.
   - No review is already outstanding (requested, not yet dismissed by a later push) — if one
     is, the push itself was already the signal; do not re-request
     ([[no-reviewer-ping-without-approval]] / [[reviewers-dont-spam]]).
   - The user's approval is for **this PR number, in this conversation** — a blanket "yes,
     signal when ready" said about a different PR, or said before this session, does not count.

2. **If any gate check fails**, stop and report exactly which one — don't ask "should I signal
   now?" as a throwaway line and proceed anyway.

3. **If every gate check passes**, request the reviewer:
   ```bash
   gh pr edit <number> --repo "$(gh repo view --json nameWithOwner -q .nameWithOwner)" --add-reviewer <reviewer>
   ```
   If `gh pr edit` fails with the known "Projects (classic)" GraphQL deprecation error on this
   repo, fall back to
   `gh api repos/$(gh repo view --json nameWithOwner -q .nameWithOwner)/pulls/<n>/requested_reviewers -f "reviewers[]=<reviewer>"` —
   and send it exactly once; verify via `gh pr view <n> --json reviewRequests` rather than
   retrying blind (a retry after an ambiguous failure is how a double-ping happens).
   Do not add a "ready for re-review" comment or @-mention on top of the request — the request
   itself is the signal; a comment on top of it is the over-notification this skill exists to
   avoid.

4. **Report** the PR as signaled, and loop back to `project-status-local` to pick up the new
   state on its next run.

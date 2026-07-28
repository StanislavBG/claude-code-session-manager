---
name: pr-review-sweep:land-and-resolve
description: Step 4 of pr-review-sweep — reply on the GitHub thread and resolve it, via one of three entry points from check-fixed/queue (already-fixed, reply-only, or a completed PRD). Runs async relative to steps 0-3 for the PRD path, typically triggered by a later project-status-local pass noticing a completed PRD.
---

# pr-review-sweep:land-and-resolve

Three entry points:

1. **Already-fixed threads** from `pr-review-sweep:check-fixed` — no PRD to wait on, act
   immediately, citing the commit that step already identified.
2. **Reply-only threads** from `pr-review-sweep:check-fixed` — no PRD, no commit; act
   immediately, citing the evidence/reasoning `check-fixed` already worked out (a repo
   convention, an intentional-design confirmation, a fact about the code the reviewer
   didn't have). **Re-verify that reasoning is still accurate right now, not just at
   classify time** — code moves between when a thread was classified and when you're about
   to reply; don't post a stale "confirmed" against code that's since changed.
3. **Queued PRDs** from `pr-review-sweep:queue` that the scheduler now reports
   `completed` — this is where this step actually waits on external state; a fresh
   `/project-status` (or manual) run is what notices the PRD finished and re-enters here.

## Steps

1. **For the PRD entry point only:** confirm the PRD actually ran its required
   verification — both independent passes, and (for a `bug` bundle) that the regression
   test genuinely exists and is green, not just claimed in the PRD's own summary. A PRD
   marked `completed` without evidence of the ACs having run is `needs_review`, not landed —
   report it as stuck, don't proceed to reply/resolve. (Already-fixed and reply-only
   entries have no PRD to verify — skip to step 2.)
2. **Confirm CI is green** on the PR (for the PRD entry point, after the PRD's commit
   landed; for already-fixed/reply-only, CI state is whatever it already is).
3. **Reply** on each thread — naming the specific fixing commit SHA for already-fixed/PRD
   entries, or the evidence/reasoning for reply-only entries — so the reviewer can verify
   without re-reading the whole diff or re-asking the question.
4. **Resolve** the thread via GraphQL `resolveReviewThread`. Order matters: reply first,
   resolve second, so there's a paper trail explaining why a thread closed before it drops
   off the unresolved list.

Needs-my-decision threads (set aside back in `pr-review-sweep:classify`), and any
policy-override thread where convention says the reviewer should be the one to close it,
are deliberately left unresolved after the reply — that is correct behavior, not an
oversight.

## Stuck PRDs

A `failed` or `needs_review` PRD is reported to the user as a stuck bundle, never silently
retried and never silently downgraded to an inline fix — re-queuing or fixing it directly
both require the user's decision, since either implies the original PRD's scope or ACs
were wrong.

## Hard constant

**Never contact a reviewer** at any point in this step — replying to a thread and
resolving it are not reviewer contact; requesting/re-requesting one is `pr-signal`'s job
alone, gated separately.

## Output

Per thread: resolved (+ the SHA it was resolved against), or reported as blocked (PRD
still in flight, or stuck) — loops back to `project-status-local`'s rollup either way.

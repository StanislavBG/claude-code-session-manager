---
name: pr-review-sweep:queue
description: Step 3 of pr-review-sweep — bundle surviving accept-as-is/policy-override threads by (PR, type) and queue one /develop PRD per bundle. Never fixes inline; the scheduler is the only place code changes happen.
---

# pr-review-sweep:queue

Only ever receives the **survives** list from `pr-review-sweep:check-fixed` — threads that
genuinely need a code change that doesn't exist yet. `check-fixed` has already routed
already-fixed and reply-only threads straight to `land-and-resolve`, so if you're looking
at a thread here, it needs real code written; don't second-guess that by trying to answer
it with a reply instead of a PRD.

Group `survives` threads by **(PR number, type)** — up to two bundles per PR, one `bug` and
one `feature`. Queue each bundle as its own `/develop` PRD. Never write the fix in this
session; this step's own actions are read-only except for the act of queuing.

## Duplicate-PRD guard (idempotency)

Before queuing a bundle, check the scheduler queue for an existing queued/in-flight PRD for
that same (PR, type). If one exists, skip queuing and report the existing PRD id instead —
re-running `pr-review-sweep` must never double-queue the same bundle. If a thread newly
qualifies for a bundle that already has an in-flight PRD (e.g. a fresh review comment
landed after the PRD was queued but before it completed), do not silently fold it in —
queue a follow-up PRD once the first completes, so each PRD's diff stays traceable to a
known snapshot of threads.

## PRD acceptance criteria, by type

Every PRD, regardless of type, ends with: commit + push to the fork branch that owns the
PR (never `origin`, never force-push, never a new PR to carry a review fix — land on the
existing PR's branch), and the standard two independent verification passes before commit.

- **`bug` bundle** — additionally require: reproduce each defect described in the bundled
  threads, write a regression test per defect that fails before the fix and passes after,
  then fix. The PRD body should quote the reviewer's exact wording per thread so the
  executor root-causes the actual reported defect, not a guessed one.
- **`feature` bundle** — additionally require: scope the change to exactly what each
  bundled thread asked for (no piggybacked scope creep across threads even though they're
  bundled together), match existing patterns/conventions in the touched files, and add a
  test only if the ask itself introduces new testable behavior.

Neither template authorizes a description edit or a reviewer request — those stay
`pr-review-sweep:land-and-resolve`'s and `pr-signal`'s jobs respectively, so a PR's
description reflects the *final* landed state, not a snapshot mid-fix.

## Output

Per (PR, type) bundle: a queued PRD id (new or pre-existing), or — if `survives` was empty
for that PR — nothing to queue, reported as such rather than silently skipped.

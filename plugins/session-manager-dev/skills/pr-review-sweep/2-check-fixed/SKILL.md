---
name: pr-review-sweep:check-fixed
description: Step 2 of pr-review-sweep — before queuing anything, triage every accept-as-is / policy-override thread into already-fixed, reply-only (no code change needed), or genuinely-open. Mandatory for every survivor, including policy-override threads — skipping it on the assumption "policy-override never needs a code check" is what caused a real wrong reply (see below).
---

# pr-review-sweep:check-fixed

Read the current file content at the cited location, and check recent git log/commits on
the PR's actual branch, for **every** accept-as-is/policy-override thread — no exceptions
for threads that look like a pure confirmation ask. **This step is mandatory before posting
any reply, not optional for policy-override threads.**

**Incident that made this mandatory:** on sigma PR #206, a policy-override thread (empty-
string EIK display) was replied to with "leaving as-is, test locks in current behavior"
without re-checking the code first — but the thread had *already been fixed* two commits
earlier by a different session. The wrong reply had to be corrected with a follow-up
comment. The cause wasn't a broken tool, it was skipping this step because the thread's
disposition (policy-override) felt like it obviously needed no verification. It didn't
obviously need verification — but it needed it anyway, and every thread does.

## Triage into three outcomes, not two

1. **Already-fixed** — the code (or a recent commit on the PR's branch) already does what
   the thread asks. Routes straight to `pr-review-sweep:land-and-resolve`, citing the
   fixing commit SHA. Skips `:queue` entirely.
2. **Reply-only, no code change needed** — the thread is fully answered by information
   that already exists (a repo convention, an intentional design documented elsewhere, a
   fact about the code the reviewer didn't have) and genuinely requires zero code change to
   resolve — not "a trivial one-line fix," but literally nothing to write. Common for
   policy-override threads whose reviewer ask was really a question ("confirm X is
   intentional") rather than a change request. Routes straight to
   `pr-review-sweep:land-and-resolve`, citing the evidence/reasoning instead of a SHA.
   **Do not send these to `:queue`** — queuing a PRD to "fix" a thread that needs no fix
   wastes a scheduler run and produces a PRD with no real acceptance criteria to execute.
3. **Genuinely open** — needs an actual code change that doesn't exist yet. Goes to
   `pr-review-sweep:queue` as before, carrying its `{disposition, type}` tags.

The dividing line between outcomes 2 and 3: if you can point to the exact existing
line/paragraph that answers the reviewer's ask, it's outcome 2. If satisfying the ask
requires writing or changing any code, however small, it's outcome 3 — don't downgrade a
real fix to "reply-only" just because it's tiny; that's what `:queue`'s bug/feature
templates are for, sized appropriately.

## Output

Three lists per PR:
- **already-fixed** (thread id + the commit/line that fixed it) → `:land-and-resolve`
- **reply-only** (thread id + the evidence/reasoning to cite) → `:land-and-resolve`
- **survives** (thread id, disposition, type) → `:queue`

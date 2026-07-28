---
name: pr-review-sweep:classify
description: Step 1 of pr-review-sweep — classify each unresolved review thread on two independent axes — disposition (accept-as-is / policy-override / needs-my-decision) and type (bug / feature) — so downstream steps can route and template correctly.
---

# pr-review-sweep:classify

Decided per-thread, never per-PR — a single PR routinely mixes threads that need very
different handling.

## Axis 1 — disposition

- **Accept-as-is** — the reviewer's ask is valid, no repo-policy reason not to do it. The
  default bucket.
- **Policy-override** — the comment conflicts with something the repo's own `AGENTS.md` /
  `CLAUDE.local.md` already decided (a staged-rollout convention, an intentional
  trade-off). Policy wins silently — no need to escalate to the user — but still reply
  explaining why, so the reviewer isn't left wondering. Verify the policy text actually
  says what you think it says before invoking this bucket; don't assume.
- **Needs-my-decision** — a genuine judgment call with no clear answer from repo policy
  alone. Stop, surface the question verbatim to the user, never guess. This bucket blocks
  only that one thread — every other thread on the PR keeps moving. A needs-my-decision
  thread never gets a type tag (axis 2 is moot until it's decided to do the work at all).

## Axis 2 — type (accept-as-is and policy-override threads only)

- **Bug** — the reviewer flagged something objectively broken: wrong output, a crash, a
  security issue, an off-by-one, a missed edge case. Anything where "what should happen
  instead" is unambiguous from the current code being wrong.
- **Feature** — the reviewer asked for additional behavior, a refactor, or a
  consistency/style improvement that isn't fixing broken behavior. If the current code does
  what it currently does *on purpose* and the ask is to make it do something more or
  different, it's a feature, not a bug — even when phrased urgently.

When genuinely ambiguous between the two (e.g. "this should also handle nulls" — is null
input a bug the code should already handle, or new scope?), default to **bug** only if
there's a concrete failing case (a real input that breaks today); otherwise **feature**.
Record the reasoning either way — `pr-review-sweep:queue` uses it to pick the PRD template,
and a future reader should be able to see why a borderline call went the way it did.

## Output

Per thread: `{disposition, type | null, reasoning}`. Needs-my-decision threads carry the
open question verbatim, collected for the final report rather than blocking the other
threads.

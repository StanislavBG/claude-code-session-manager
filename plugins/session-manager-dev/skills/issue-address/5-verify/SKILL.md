---
name: issue-address:verify
description: Step 4 of issue-address — prove the new reproduction test passes AND the full existing test suite/typecheck still pass (no regressions), given a fix from issue-address-fix. The gate before requesting-code-review.
---

# issue-address:verify

Called after `issue-address:fix` lands a fix and confirms the single reproduction test is
green. This step's job is the broader safety net.

## Steps

1. **Re-run the reproduction test** on its own once more — confirm green (belt-and-braces,
   in case an intervening change touched it).

2. **Run the project's full relevant test suite** — not a hand-picked subset:
   ```bash
   pnpm --filter <affected-package> test
   ```
   and if the fix touches more than one workspace package, run each affected package's
   suite. Report the actual pass count (e.g. "419/419 passed"), not just "tests pass."

3. **Run typecheck**:
   ```bash
   pnpm --filter <affected-package> typecheck
   ```
   A green test suite with a broken typecheck is not done.

4. **If anything besides the target reproduction test is red**, fix it before proceeding —
   never report this step as passed on a partially red suite. Identify whether the new
   failure is a genuine regression from this fix or a pre-existing flake (check if it
   fails on the base branch too, via stash/checkout if needed) before deciding how to
   handle it.

## Output

A clean verification report (suite name → pass count, typecheck status) to hand to
`requesting-code-review` (existing skill, not nested here) for the independent review
pass — call that skill synchronously and read its result before considering the issue
resolved.

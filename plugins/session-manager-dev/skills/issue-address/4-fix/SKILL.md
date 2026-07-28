---
name: issue-address:fix
description: Step 3 of issue-address — root-cause and implement the fix for a reproduced issue, given the failing test from issue-address-reproduce. Does not run the broader verification pass — that's issue-address-verify.
---

# issue-address:fix

Called after `issue-address:reproduce` hands off a failing test + root-cause hypothesis.

## Steps

1. **Confirm the root cause**, not just the symptom the test exercises — read the
   surrounding code for the actual invariant being violated. A fix that makes the specific
   test pass without addressing the underlying cause will resurface as a different bug
   later.

2. **Check for an existing helper/pattern before writing new logic** (API-reuse standard):
   search the codebase for a similar computation/validation/formatting already
   implemented elsewhere. Extend or reuse it rather than forking a parallel
   implementation.

3. **Implement the fix** — the smallest correct change that addresses the root cause, in
   the style/conventions of the surrounding code.

4. **Run the reproduction test from step 2 only** (not the full suite yet — that's the
   next skill) to confirm it now passes. If it still fails, iterate on the fix, not the
   test.

## Output

Hand off to `issue-address:verify`: the diff, the now-passing reproduction test, and a
one-line statement of the actual root cause fixed (for the eventual commit message and
review).

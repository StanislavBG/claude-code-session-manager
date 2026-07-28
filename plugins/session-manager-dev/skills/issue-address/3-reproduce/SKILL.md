---
name: issue-address:reproduce
description: Step 2 of issue-address — reproduce a confirmed-open issue locally with a failing test (red), using hypothesis-driven debugging. Stops and reports if the issue doesn't actually reproduce.
---

# issue-address:reproduce

Called after `issue-address:confirm-open` returns GO, with the issue's title/body/repro
steps in hand. Leans on `systematic-debugging` and `test-driven-development`.

## Steps

1. **Form an explicit hypothesis** for what's actually broken, grounded in the issue's
   description — name the file/function you expect is at fault and why, before touching
   anything.

2. **Locate the relevant code path** — search for the function/route/query the issue
   describes; read it fully before writing a test against it.

3. **Write a test that captures the reported bug.** It must exercise the exact scenario
   the issue describes (same inputs, same expected-vs-actual mismatch), using this repo's
   existing test patterns/helpers for that area (reuse fixtures, don't invent parallel
   ones).

4. **Run it and confirm it fails (red)** — this is the proof the bug is real, not just
   assumed from the issue text. Capture the actual failure output.

5. **If it does NOT fail** (test passes immediately): the issue may already be fixed,
   stale, or a misunderstanding. **Stop and report this** rather than fabricating a fix for
   a bug that doesn't reproduce — this is a valid, useful outcome, not a failure of the
   skill.

6. **If reproduction is hard**, bisect rather than guess repeatedly: halve the input or
   code path, or check `git log` on the relevant files for a recent change that lines up
   with when the bug was reported. Record each bisection step.

## Output

Hand off to `issue-address:fix`: the failing test (file:line), the confirmed root-cause
hypothesis, and the actual red-phase failure output as evidence.

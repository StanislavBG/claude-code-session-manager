---
title: "Fix: port runVerify.test.cjs onto vitest so its acceptance gate is actually runnable"
cwd: /home/bilko/Projects/session-manager
parallelGroup: 812
estimateMinutes: 25
---

# Context — read this first

You are the executor. Implement the acceptance criteria below directly, in this run, with a real
code diff and a real commit. Do NOT invoke `/develop`, `/process-feedback`, or any other
queue-authoring skill, and do NOT call `ScheduleWakeup`. A queued PRD is the task, not evidence
that the task is done.

**Do not substitute a different verification command for the one this PRD names.** The prior run
of the predecessor PRD failed for exactly that reason (see Root cause).

# Root cause

The predecessor PRD `812-verifier-self-recovery-sleep-prefix-normalization` asked for
sleep-prefix normalization in `isSelfRecovered()`. **That implementation already landed** in
commit `dc4294c` ("fix(scheduler): normalize sleep-prefix in isSelfRecovered comparisons"):

- `normalizeDescForRecovery()` exists at `src/main/runVerify.cjs:274`, is used at `:289` and
  `:302`, and is exported at `:852`.
- Three regression tests exist in `src/main/__tests__/runVerify.test.cjs` (around lines 392–600):
  the `sleep 20 && gh pr checks 188 …` → bare-retry recovery case, a narrow-strip unit test on
  `normalizeDescForRecovery`, and a negative test proving two different commands are not paired.

So there is **no missing feature work here.** The failure was in the last acceptance criterion:

```
timeout 120 npx vitest run src/main/__tests__/runVerify.test.cjs
```

`src/main/__tests__/runVerify.test.cjs` is the one main-process test file still written against
the **`node:test`** runner with CommonJS `require` (`const { test } = require('node:test');`,
`const assert = require('node:assert/strict');`), and it is **not listed** in `vitest.config.ts`'s
explicit `include` allowlist. Running the AC command today gives:

```
No test files found, exiting with code 1
```

Every other main-process test registered in that allowlist (e.g. `prdMigration.test.cjs`,
`rcaFeedbackHook.test.cjs`, `scheduler-find-prd-dir.test.cjs`) uses ESM `import { test, expect }
from 'vitest'` despite the `.cjs` extension — vite transforms them. `runVerify.test.cjs` is the
odd one out.

The prior executor, faced with the unsatisfiable AC, edited `vitest.config.ts` to remove a
runVerify entry, reverted that edit, then ran `node --test src/main/__tests__/runVerify.test.cjs`
(38/38 green), declared "the literal `npx vitest run` command in the AC doesn't apply", printed
`SCHEDULER_VERDICT: PASS`, and committed nothing. That is a substituted-verification false PASS:
a named gate was never made green. `CLAUDE.md` is explicit that this repo does not use
`node --test` — so the correct resolution is to make the file a real vitest test, not to keep
a second runner alive for one file.

# Fix steps

1. Read `src/main/__tests__/runVerify.test.cjs` and `vitest.config.ts`.
2. Port `runVerify.test.cjs` onto the vitest runner, matching the style of the already-registered
   `.cjs` main tests:
   - Replace `const { test } = require('node:test');` with `import { test } from 'vitest';`
   - Convert the remaining top-of-file `require(...)` calls to ESM `import` statements
     (`node:assert/strict`, `node:os`, `node:fs`, `node:path`, and `../runVerify.cjs`).
     Keep `node:assert/strict` assertions as-is — `assert` works fine under vitest; do NOT
     rewrite ~38 tests' assertions to `expect`, that is out of scope and pure churn.
   - Check the whole file for any other `require(` / `module.exports` usage introduced inside
     test bodies and convert or leave as appropriate so the file loads as an ES module.
   - Drop the `'use strict';` pragma if it conflicts with ESM (ESM is always strict).
   - Update the file's header comment: the "Run standalone: node src/main/__tests__/runVerify.test.cjs"
     line is now wrong — replace it with the vitest command.
3. Register the file in `vitest.config.ts`'s `include` array, appended to the existing
   `src/main/__tests__/...` entries (keep the list's existing ordering convention).
4. Run the verification commands below. If any test fails during the port, fix the port — do
   **not** weaken or delete a test, and do **not** touch `src/main/runVerify.cjs`'s behavior.
   The test count must stay at 38 or more.

# Out of scope

- Any change to `isSelfRecovered()` / `normalizeDescForRecovery()` behavior in
  `src/main/runVerify.cjs` — that work is already correct and shipped in `dc4294c`.
- Converting other test files' runners.
- Rewriting `assert.*` calls to `expect(...)`.

# Verification commands

Run all three, bounded, and let the last one be green:

```
timeout 180 npx vitest run src/main/__tests__/runVerify.test.cjs
timeout 300 npm run typecheck
timeout 600 npm run test:unit
```

The first command must report the file as found and all its tests passing (it currently exits 1
with "No test files found" — that is the bug you are fixing). `npm run test:unit` must not
regress any other file.

# Acceptance criteria

- [ ] `src/main/__tests__/runVerify.test.cjs` imports its test runner from `vitest`, not
      `node:test`, and uses ESM `import` at the top of the file
- [ ] `src/main/__tests__/runVerify.test.cjs` is listed in `vitest.config.ts`'s `include` array
- [ ] `timeout 180 npx vitest run src/main/__tests__/runVerify.test.cjs` finds the file and passes,
      with ≥38 tests reported (no test deleted, skipped, or weakened)
- [ ] The three sleep-prefix regression tests from `dc4294c` (sleep-prefixed FAIL recovered by a
      bare retry → clean; `normalizeDescForRecovery` narrow-strip unit test; two different
      commands not paired) are all present and green under vitest
- [ ] `src/main/runVerify.cjs` is unmodified by this PRD (`git diff` shows no change to it)
- [ ] `timeout 300 npm run typecheck` passes
- [ ] `timeout 600 npm run test:unit` passes with no new failures
- [ ] The work is committed during this run, and the run ends with a truthful
      `SCHEDULER_VERDICT: PASS`

## Engineering standards

## Execution discipline (headless runs)

Data-driven from 400+ scheduler runs: long hangs (not bad code) are the dominant real failure, and "exited clean but left a red test" is the top verifier downgrade. These rules run at execution time — they are inlined into every PRD because the headless executor reads nothing else.

- **Bound every command.** Wrap every test/build/dev-server/deploy/poll command in a hard timeout: `timeout 300 <typecheck|unit>`, `timeout 120 <one e2e spec>`, `curl --max-time 15`. Never run a bare `playwright test`/`vite`/`pnpm dev`, a full e2e suite, or an endpoint-polling publish — those are the SIGTERM/4h-watchdog tail.
- **Verify before done.** Run the acceptance test command once before declaring success. If it's red, fix it or `exit 1` with the failure — never end the run on a failing test (that trips the verifier's `transcript_errors` downgrade).
- **Fail loud, fail fast.** On any step failure, print one diagnostic line and `exit 1`; don't swallow with `|| true` or spin in a silent retry. A `rateLimited` exit-1 is the scheduler's benign auto-pause (auto-resumes next window) — not a failure to engineer around.
- **Stay in the AC.** Do not add work past the acceptance checklist ("while we're here" generators/fixtures are the post-AC-overrun incident). Body must be clean UTF-8 — no NUL/control bytes.
- **You ARE the executor — never re-queue or self-schedule.** A headless PRD run must perform its own acceptance criteria directly. Do NOT invoke `/develop`, `/process-feedback`, or any queue-authoring skill from inside a run — those are interactive main-loop skills that author a *new* PRD and return, so the run exits 0 having done nothing (no commit, no sentinel → `needs_review` with `no_verdict_sentinel`). Do NOT call `ScheduleWakeup`/set a tracking loop either — the process exits when the run ends and nothing re-invokes it. This applies just as much to spawning your own review agents and waiting on them: do NOT invoke `/code-review`, `/security-review`, `requesting-code-review`, or any other skill/subagent as a background/async step and then end your turn with something like "I'll wait for the review agents to complete" — a headless run has no next turn, so that line is the run's last output, no verdict sentinel prints, and the job parks in `needs_review` even though the actual work already landed. If a PRD's acceptance criteria call for a second review pass, run it **synchronously, inline, before the finish protocol** — call the reviewer and read its result in the same turn, don't fire-and-wait. If the PRD's work looks large, decompose and execute it inline within this run; never delegate it back to the queue. (Incidents: PRD 460 invoked `/develop`, spawned a duplicate PRD 461, and exited 0 with no work. PRD 479 landed its commit correctly but then backgrounded `/code-review --fix` + `/security-review` and called `ScheduleWakeup` to "wait" for them — same class of failure, different entry point.)
- **A shared-repo `cwd` can be occupied by a concurrent job — check before you touch shared state.** When a PRD's `cwd` is a repo other headless runs may also target (a shared team repo like sigma, not a private single-purpose project), a `git checkout`/`gh pr checkout` can land you in another job's live worktree with its own uncommitted WIP. Before running `git stash`, `git reset`, or any command that discards or hides working-tree state, check `git stash list` and `git status` first, and if you must set aside pre-existing uncommitted changes that aren't yours, **stash with a descriptive message** (`git stash push -m "pre-existing WIP found by PRD <NN>, not mine"`) and **restore it before your run ends** (or, if you can't safely restore because your own commit depends on that worktree state, leave it stashed with the message and say so explicitly in your finish output — never let the run end silently dropping someone else's stash). Never `git stash drop`/`git clean -fd` on state you didn't create. (Incident: PRD 477 stashed a concurrent job's rAF-throttle-revert WIP to get its own checkout, finished, and exited without restoring it — orphaning the other job's uncommitted work in `stash@{0}` with no record of whose it was.)
- **`gh pr edit --body` can fail on repos with legacy GitHub Projects (classic) boards** — the underlying GraphQL query fetches `repository.pullRequest.projectCards`, a field GitHub is sunsetting, and errors with `GraphQL: Projects (classic) is being deprecated ... (repository.pullRequest.projectCards)` even though the edit itself would otherwise succeed. This is a known `gh` CLI quirk, not a defect in your work. Prefer `gh api -X PATCH repos/<owner>/<repo>/pulls/<n> -f body="$(cat body.md)"` for updating a PR description headlessly — it doesn't touch the deprecated field. If you do use `gh pr edit` and it fails this way, don't leave the bare GraphQL error as the last thing in that step (it reads as an unrecovered error in the final-20%-of-transcript verifier heuristic): immediately retry with the `gh api` form and print one line noting the known-bug fallback, so the recovery is adjacent to the error.
- **`gh pr checks`/`gh run watch` exit non-zero while CI is merely *pending*, not failed — don't let that surface as a bare error.** Polling `gh pr checks <n>` before checks finish returns a non-zero exit (e.g. 8) with output like `check  pending  0  <url>` — this is normal, documented `gh` CLI behavior, not a failure. If you retry with a *differently-worded* command (e.g. dropping a `sleep N &&` prefix, or switching to `gh run watch <id> --exit-status`), the verifier's self-recovery detector pairs retries by exact command-description match and may not recognize the differently-worded retry as the same recovery, leaving the original pending-state error looking unrecovered in the transcript (incident: `745-pr188-ci-lint-docs-integrity`, a fully green, committed, pushed run flagged `needs_review` over exactly this). Prefer polling with the *same* command/description each time (e.g. loop `gh pr checks <n>` unchanged, or use `gh run watch <id> --exit-status` from the start rather than switching mid-poll) so a later success is recognized as recovering the earlier pending-state failure.
- **Negative-assertion checks must exit 0 when clean.** A check that verifies the *absence* of something (a `grep` that should find nothing, "no leftover X", `diff` expecting no change) must return exit 0 on the clean case. A bare `grep` exits **1 on no-match** — so the *success* path surfaces as `is_error=true` and the verifier downgrades a perfect run to `needs_review`. Always invert: `if <detector>; then echo "HALT: <what was found>"; exit 1; fi; echo clean`. Never let the no-match/empty path carry the non-zero exit.
- **Recover or annotate every error — don't strand a Traceback in the transcript.** The verifier downgrades an otherwise-perfect run to `needs_review` when a `Traceback`/`Error` appears with *no visible recovery within ~10 lines* (the `transcript_errors` heuristic — the single most common false-positive on green deliverables). Two executor habits cause it: (1) **throwaway probes that error** — an inline `python -c` with a quoting/f-string slip, a wrong kwarg, a bad path. When a probe errors, immediately re-run the corrected version *or* print one line `# expected/handled: <why>` right after, so recovery is adjacent. Don't move on leaving a bare error as the last thing in that step. Prefer a small temp `.py` file over a fragile multi-quote `python -c` one-liner (inline f-string errors are the top source of stranded tracebacks). (2) See the timeout rule below.
- **An *expected* bounded-timeout (exit 124) must be annotated, not bare.** `timeout`-capping a genuinely long task you expect to hit the cap (a full-universe ingest, a long scan) is correct — but a bare `Exit code 124` reads as a failure to the verifier. Wrap it so the cap is a success-with-note: `timeout 120 <cmd> || { rc=$?; [ $rc -eq 124 ] && echo "hit time cap — idempotent/partial, rows persist incrementally; OK" || { echo "HALT: <cmd> failed rc=$rc"; exit 1; }; }`. (Distinguish 124 = expected cap from a real non-zero.) For work that legitimately needs longer than a safe cap, run it in the background and poll a bounded number of times rather than capping the foreground command.
- **Polling remote CI/job status: never `sleep N && <cmd>`, and annotate the pending exit code.** The harness hard-blocks a `sleep` chained to another command (`Blocked: sleep 90 followed by: gh pr checks ...`) and that block lands in the transcript as a bare `is_error=true` — usually in the last 20% of the run, right where the verifier weighs errors most. To wait for a remote run, use the tool's own blocking watcher under a hard cap: `timeout 600 gh run watch <run-id> --repo <owner>/<repo> --exit-status`. Also note `gh pr checks` is a **negative-assertion-shaped command**: it exits `8` while checks are pending and `1` when a check failed or none are reported — so the ordinary "still running" path is non-zero. Wrap it so the expected cases print a clean token rather than a bare error: `if out=$(timeout 60 gh pr checks <n> --repo <r> 2>&1); then echo "CI GREEN"; else rc=$?; echo "gh pr checks rc=$rc (8=pending, 1=fail/none) — expected/handled"; fi`. (Incident: PRD 745 fixed PR #188's Lint + Docs-integrity failures, pushed, and CI went fully green — but its `sleep 20 && gh pr checks` (exit 8) and `sleep 90 && gh pr checks` (harness-blocked) sat unannotated at the very end of the transcript and the run was flagged despite a truthful PASS and a landed commit.)
- **Finish so the verifier auto-clears you.** The scheduler appends a finish protocol that requires you to COMMIT your work and emit `SCHEDULER_VERDICT: PASS` (or `FAIL <reason>` + `exit 1`) as the literal last line. Honor it exactly: a *truthful* PASS plus a commit that landed during the run is what lets the verifier override incidental transcript noise (a grep hit containing "Error", a TDD red-phase run, a debug Traceback) instead of parking the job in `needs_review` for a human. A job that exits 0 with **uncommitted** changes, or with no PASS sentinel, is the #1 cause of needless `needs_review`. Never print PASS on a red gate — a lying PASS turns the verifier into a silent-failure shipper.
- **Don't leak expected-error text into tool output.** The verifier pattern-matches transcript content for `Traceback`/`FAIL`/`Error:`. When a step is *expected* to error (a TDD red-phase test, an availability/existence probe, a "should raise" assertion), don't let the raw exception land verbatim — capture it and surface a clean token instead: `if python -c '…' 2>/dev/null; then echo PROBE_OK; else echo PROBE_ABSENT; fi`, or pipe the noisy run through a matcher that prints only `RED (expected)` / `GREEN`. When you retry a transient failure, re-run the **same command with the same description** — the verifier's self-recovery detector pairs a failed call with a later identical-description call that succeeds and clears it.
- **End green: run the acceptance/test gate LAST, and let nothing error after it.** The post-run verifier scans the transcript and downgrades to `needs_review` on error markers — and weighs the *final* portion of the run most heavily (a tool error in the last ~20% trips it even if everything actually passed). So order the run so the last command is the green AC gate: do any intentionally-failing step (e.g. a TDD red test, an expected-nonzero probe) **early**, never after the gate. If you must demonstrate a failure late, capture it so it doesn't surface as a raw `is_error`/`Traceback` (`… 2>&1 | tail` inside a conditional, or assert on the captured text) rather than letting it hit the transcript bare.
- **The verdict sentinel is your authoritative "I passed" signal — emit it truthfully.** The scheduler appends a FINISH PROTOCOL that ends by printing `SCHEDULER_VERDICT: PASS` once the AC gate is green and the commit has landed (or `SCHEDULER_VERDICT: FAIL <reason>` + `exit 1` otherwise). The verifier treats `PASS` + a commit that landed during the run as **authoritative** and overrides incidental transcript markers — so a *deliberately reproduced* red test (systematic-debugging) or a grep result containing the word "Error" will **not** false-trip `needs_review`, as long as the run genuinely ends green and committed. Never print `PASS` when the gate is red — that's the one thing that turns a safety net into a silent-failure machine.

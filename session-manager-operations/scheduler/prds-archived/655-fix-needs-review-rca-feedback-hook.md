---
title: "Fix: exempt truthful no-op re-runs of already-shipped PRDs from the pass_no_commit verdict"
cwd: /home/bilko/Projects/session-manager
parallelGroup: 655
estimateMinutes: 45
---

# Root cause

PRD `655-needs-review-rca-feedback-hook` was a **stale re-queue of work that had already
shipped**. The headless run did everything right:

- `git status --short` on `src/main/lib/rcaFeedbackHook.cjs`, `src/main/__tests__/rcaFeedbackHook.test.cjs`,
  `src/main/scheduler.cjs` → clean.
- `git log --oneline` on those paths → the feature landed in `e13168d`
  ("feat(scheduler): file a deterministic RCA into the target project's feedback inbox on
  needs_review"), then `5864433` and `9cf0384`.
- `timeout 300 npm run typecheck` → green.
- `timeout 120 npx vitest run src/main/__tests__/rcaFeedbackHook.test.cjs` → 23/23 passed.
- It correctly declined to fabricate a no-op commit and printed a truthful
  `SCHEDULER_VERDICT: PASS`. Exit code 0, 39s, no errors anywhere in the transcript.

It was still parked in `needs_review`. The reason is the `pass_no_commit` rule in
`src/main/runVerify.cjs` (~line 743):

```js
const isFixPlanJob = /^\d+-fix-/.test(queueEntry?.slug || '');
if (sentinel === 'pass' && !committedDuringRun && !isFixPlanJob) { ... }
```

That rule already carries **two** exemptions for precisely this false-positive shape:

1. **fix-plan slugs** (`^\d+-fix-`) — added 2026-07-12 after `523-fix-bounded-fix-plan-retry`
   re-verified an already-landed PRD, correctly made no commit, and got flagged anyway.
2. **`-merge-main` slugs** — independently re-checked via `gh pr view` (`pass_no_commit_target_verified`).

It has **no** exemption for the third, equally legitimate case: an *original* PRD re-run after
its own deliverables already landed in earlier commits. For that case "there is nothing to
change" is the correct, truthful outcome, not a silent-failure signal.

This is a **verifier false positive**, not a defect in `rcaFeedbackHook.cjs` (which is complete,
wired, and green) and not an executor defect. Do NOT re-implement the RCA hook — it exists.

Secondary contributing cause: the stale PRD file
`session-manager-operations/scheduler/prds/655-needs-review-rca-feedback-hook.md` was never
archived after the feature shipped, so the queue keeps re-running already-done work — which now
also generates an RCA feedback item on every cycle.

## NOT the failure class here (for the record)

This run did **not** self-delegate. It did not invoke `/develop`, `/process-feedback`, or
`ScheduleWakeup`. It executed its own verification inline and finished correctly. The canonical
rule still applies to *you* (see Engineering standards below): **you ARE the executor — never
re-queue or self-schedule.** A queued PRD is the task, not evidence of completion; your
deliverable here is the code diff described below, committed during this run.

# Fix steps

## Step 1 — Red test first

Add tests to `src/main/__tests__/runVerify.test.cjs`, next to the existing
`pass_no_commit` block (~line 1098). Model them on the fix-plan and merge-main exemption tests
already there (they build a fake `runDir` + log + `queueEntry`, then assert on
`verdict.verdict`).

New cases:

1. **Exempt:** original slug (e.g. `655-needs-review-rca-feedback-hook`), `sentinel === 'pass'`,
   `committedDuringRun === false`, and **every** deliverable file path named in the PRD body is
   already tracked in git → verdict `pass_no_commit_already_shipped`, `downgradeTo` null/undefined.
2. **Not exempt:** same shape, but at least one PRD-named deliverable path is NOT tracked in git
   → falls through to `pass_no_commit` (unchanged behavior).
3. **Not exempt / fail-safe:** PRD body names zero extractable deliverable paths → falls through
   to `pass_no_commit` (never exempt on absence of evidence).
4. Existing `pass_no_commit`, fix-plan-exemption, and merge-main-exemption tests must still pass
   unchanged.

Run them first and confirm they are RED before writing the implementation. Capture the red run
so a raw failure string does not strand in the transcript, e.g.:

```
if timeout 120 npx vitest run src/main/__tests__/runVerify.test.cjs >/tmp/red.txt 2>&1; then echo "UNEXPECTED_GREEN"; else echo "RED (expected)"; fi
```

## Step 2 — Implement the exemption in `src/main/runVerify.cjs`

Add two pure helpers near `isMergeMainSlug` / `extractMergeMainPrNumber` (~line 470-497), with
doc comments in the same voice as the surrounding code:

```js
/**
 * Extract the deliverable file paths a PRD body names — backticked or bare paths
 * under a source dir with a file extension (e.g. `src/main/lib/foo.cjs`,
 * `src/renderer/components/Bar.tsx`, `scripts/baz.cjs`). Deliberately narrow:
 * only repo-relative paths, no globs, no node_modules, no URLs.
 * O(n) over the PRD body length.
 */
function extractPrdDeliverablePaths(prdBody) { ... }

/**
 * Materially check whether every deliverable path a PRD names is already tracked
 * in git — i.e. the PRD's work landed in an EARLIER run/commit and this run
 * correctly had nothing to do. Uses `git ls-files --error-unmatch -- <paths>`
 * (bounded, execImpl injectable for tests). Fails safe in every direction: any
 * error, a non-git cwd, or zero extracted paths returns false, which falls
 * straight through to today's pass_no_commit behavior.
 */
function allDeliverablesAlreadyTracked({ cwd, paths, execImpl = execFileSync, timeoutMs = 15_000 }) { ... }
```

Then extend the guard at ~line 743. Keep the existing fix-plan and merge-main exemptions
untouched; add the new branch **inside** the `if (sentinel === 'pass' && !committedDuringRun && !isFixPlanJob)`
block, before the final `issues.push({ verdict: 'pass_no_commit', ... })`, mirroring how
`mergeMainVerified` short-circuits:

```js
// EXEMPTION: an ORIGINAL PRD re-queued after its deliverables already landed.
// "I checked, the work is already committed and green, nothing to change" is a
// truthful PASS, not a silent no-op — the same reasoning that exempts fix-plan
// slugs above. Materially checked against real git state, never inferred from
// the transcript. (Incident: 655-needs-review-rca-feedback-hook, 2026-07-31 —
// verified rcaFeedbackHook.cjs shipped in e13168d, ran typecheck + 23 green
// tests, made no commit, printed a truthful PASS, and was parked anyway.)
```

On success return via `conclude('pass_no_commit_already_shipped', <reason naming the tracked
paths>, null, { ...(annotations.length ? { annotations } : {}), sentinel, alreadyTrackedPaths })`.

## Step 3 — Teach the callers the new verdict

`pass_no_commit_already_shipped` is a **clean** outcome, exactly like
`pass_no_commit_target_verified`. Update both call sites in `src/main/scheduler.cjs` that
special-case that verdict so they accept the new one too:

- ~line 2195-2198 (the live post-run verdict mapping).
- ~line 2929-2932 (the periodic re-verify path).

Also add `'pass_no_commit_already_shipped'` to `RESCANNABLE_VERDICTS` (~line 2766) — same
reasoning as the comment already there for `pass_no_commit`: re-scanning is a harmless no-op
on the same facts.

Add the label to `VERDICT_LABELS` in `src/main/lib/rcaFeedbackHook.cjs` (~line 57-59) so an RCA,
if one is ever filed for it, reads in English:

```js
pass_no_commit_already_shipped: 'PASS with no commit — deliverables already shipped',
```

## Step 4 — Archive the stale PRD

The feature is shipped; the PRD file should stop re-running.

```
git mv session-manager-operations/scheduler/prds/655-needs-review-rca-feedback-hook.md \
       session-manager-operations/scheduler/prds-archived/655-needs-review-rca-feedback-hook.md
```

If `prds-archived/` does not exist, create it first. If the file has already been moved by
another job, print one line saying so and continue — do not fail the run over it.

# Verification

Run these in order; the LAST command must be the green gate.

```
timeout 300 npm run typecheck
timeout 180 npx vitest run src/main/__tests__/runVerify.test.cjs
timeout 120 npx vitest run src/main/__tests__/rcaFeedbackHook.test.cjs
timeout 420 npm run test:unit
```

Note: `SM_CHAT_CONCURRENCY` in the shell profile can make `chatRunner.spec` red locally. If that
single spec fails, `unset SM_CHAT_CONCURRENCY` and re-run the same command with the same
description before concluding anything about it.

# Acceptance criteria

- [ ] `src/main/runVerify.cjs` exports/defines `extractPrdDeliverablePaths` and
      `allDeliverablesAlreadyTracked`, both pure/injectable and fail-safe (any error → `false`).
- [ ] `pass_no_commit` no longer fires when an original PRD's PASS-with-no-commit is backed by
      every PRD-named deliverable path being tracked in git; that case concludes
      `pass_no_commit_already_shipped` with `downgradeTo` null.
- [ ] Zero extracted paths, any untracked path, non-git cwd, or any `git` error → unchanged
      `pass_no_commit` behavior. No exemption on absence of evidence.
- [ ] Existing fix-plan (`^\d+-fix-`) and `-merge-main` exemptions and all existing
      `runVerify.test.cjs` cases still pass, unmodified.
- [ ] `src/main/scheduler.cjs` treats `pass_no_commit_already_shipped` as clean at both call
      sites (~2195-2198 and ~2929-2932) and includes it in `RESCANNABLE_VERDICTS`.
- [ ] `VERDICT_LABELS` in `src/main/lib/rcaFeedbackHook.cjs` has a human label for the new verdict.
- [ ] New tests added to `src/main/__tests__/runVerify.test.cjs` covering: exempt case,
      untracked-path fall-through, zero-paths fall-through. Written red first.
- [ ] `session-manager-operations/scheduler/prds/655-needs-review-rca-feedback-hook.md` is moved
      to `prds-archived/` (or already absent).
- [ ] `timeout 300 npm run typecheck` and `timeout 420 npm run test:unit` both green, run last.
- [ ] Work is COMMITTED during this run, then `SCHEDULER_VERDICT: PASS` printed as the literal
      last line.

# Out of scope

- Re-implementing or modifying `src/main/lib/rcaFeedbackHook.cjs`'s behavior — it is complete,
  wired, and green. Only the `VERDICT_LABELS` entry changes.
- Changing auto-fix eligibility/caps, the DoD drain hook, or the external watchdog.
- Any LLM call in the verifier path — the exemption must be deterministic git state only.
- Suppressing RCA filing for no-op re-runs (a separate concern; the verdict fix removes the
  trigger anyway).

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

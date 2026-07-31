---
title: "Fix: archive the already-shipped SELF_QUEUE PRD and classify no-op re-runs as ALREADY_SHIPPED"
cwd: /home/bilko/Projects/session-manager
parallelGroup: 812
estimateMinutes: 35
---

# Context — read this first

**The work this PRD's parent asked for is already done and on `main`.** Do NOT re-implement it.

PRD `812-rca-self-delegation-failure-class` asked for a `SELF_QUEUE` failure class in
`src/main/lib/rcaFeedbackHook.cjs`. That landed in commit **`9cf0384`** ("fix(rca): classify
self-queue/fire-and-wait failures deterministically", 2026-07-30 23:58 PT), which added
`FAILURE_CLASSES.SELF_QUEUE`, `SELF_QUEUE_SKILL_RE` / `SELF_QUEUE_WAKEUP_RE`, the
pre-`STUCK_LOOP` ordering in `classifyFailure()`, the `PREVENTION_HINTS` entry, and 29 lines of
tests in `src/main/__tests__/rcaFeedbackHook.test.cjs`.

## Root cause of the failed run

At 07:25Z on 2026-07-31 the scheduler ran that PRD **again**, 27 minutes after `9cf0384`. The
executor behaved correctly: it re-verified each acceptance criterion against the live source, ran
`npm run typecheck` (clean) and `npx vitest run src/main/__tests__/rcaFeedbackHook.test.cjs`
(23/23 green), found nothing left to change, and printed a truthful `SCHEDULER_VERDICT: PASS`,
exiting 0.

The verifier still parked the job in `needs_review` with verdict `pass_no_commit` — **no commit
landed during the run**. `classifyFailure()` buckets `pass_no_commit` as `NO_SENTINEL`, whose
prevention hint ("end every run with a truthful sentinel") is wrong and useless here: the run did
emit a truthful sentinel.

So the real defect is **queue hygiene plus a misleading classification**:

1. The PRD `.md` was never moved out of `session-manager-operations/scheduler/prds/` after
   `9cf0384`. `queueOps.cjs`'s `autoArchiveCompleted` / `selectAutoArchivable` only archive PRDs
   whose job row is `completed` **and** older than `HISTORY_RETENTION_MS` — far longer than the
   27-minute re-run gap. So the file stayed live and eligible to run again.
2. Any such re-run is *structurally guaranteed* to end in `needs_review`, because a correct
   executor with nothing to do cannot produce a commit.

This is a recurring class, not a one-off — see commit `99d2bd2`, "chore(feedback): triage 3
PRD-812 RCA items — all stale re-runs of already-shipped fixes".

**Note:** this was NOT a self-delegation failure. The run made no `Skill` or `ScheduleWakeup`
calls. Do not "fix" it by touching the SELF_QUEUE matchers.

# Goal

Two parts:

1. **Queue hygiene** — archive the already-shipped `812-rca-self-delegation-failure-class.md` so
   it stops being re-run, and commit the pending PRD/feedback files that document this pass.
2. **Classification** — add an `ALREADY_SHIPPED` failure class to `rcaFeedbackHook.cjs` so a
   no-op re-run of already-landed work gets an accurate, actionable prevention hint ("archive the
   PRD") instead of the misleading `no-sentinel` one.

# Concrete fix steps

## Part 1 — archive the shipped PRD

```bash
cd /home/bilko/Projects/session-manager
# confirm the work really is on main before archiving (all three must print):
grep -n "SELF_QUEUE: 'self-queue'" src/main/lib/rcaFeedbackHook.cjs
grep -n "SELF_QUEUE_SKILL_RE\|SELF_QUEUE_WAKEUP_RE" src/main/lib/rcaFeedbackHook.cjs
git log --oneline -1 9cf0384
```

If any of those three do NOT print, STOP: the premise of this PRD is wrong — print
`SCHEDULER_VERDICT: FAIL premise invalid — 9cf0384 work not present` and `exit 1`.

Otherwise move the shipped PRD into the project-local archive directory (it already exists —
`session-manager-operations/scheduler/prds-archived/`):

```bash
mkdir -p session-manager-operations/scheduler/prds-archived
git mv -f session-manager-operations/scheduler/prds/812-rca-self-delegation-failure-class.md \
       session-manager-operations/scheduler/prds-archived/ 2>/dev/null \
  || mv session-manager-operations/scheduler/prds/812-rca-self-delegation-failure-class.md \
        session-manager-operations/scheduler/prds-archived/
```

(The file is untracked, so `git mv` will likely fail — the plain `mv` fallback is expected and
fine. Do not treat that as an error.)

Do **not** archive this fix-plan PRD itself, and do not touch any other PRD in `prds/`.

## Part 2 — `ALREADY_SHIPPED` classification

Edit `src/main/lib/rcaFeedbackHook.cjs`. Read lines 66–160 first (the
`FAILURE_CLASSES` / `PREVENTION_HINTS` / `classifyFailure` block) and follow the existing style
exactly — plain regex tests over the log tail, no JSON parsing, no LLM.

1. Add to `FAILURE_CLASSES`, as the first entry (before `SELF_QUEUE`):

   ```js
   ALREADY_SHIPPED: 'already-shipped',
   ```

2. Add a `PREVENTION_HINTS[FAILURE_CLASSES.ALREADY_SHIPPED]` entry, worded equivalently to:

   > This run found its acceptance criteria already satisfied by a prior commit and correctly
   > made no change, so no commit landed and the verifier returned `pass_no_commit`. This is a
   > stale re-run, not an execution failure — the PRD's `.md` was never moved out of
   > `session-manager-operations/scheduler/prds/` after the work shipped. Archive the PRD into
   > `session-manager-operations/scheduler/prds-archived/` instead of re-queuing or re-running it.

3. Add a module-level regex next to the existing `SELF_QUEUE_*` ones:

   ```js
   const ALREADY_SHIPPED_RE = /already (fully )?(satisfied|implemented|committed|done|shipped)|was (already )?(implemented|committed) in|nothing (new )?to commit|no (code )?changes were needed/i;
   ```

4. In `classifyFailure({ verdict, logTail })`, add this check **first — before the `SELF_QUEUE`
   check** — but gate it on the verdict so it can only fire on the exact no-diff shape:

   ```js
   if (
     (verdict === 'pass_no_commit' || verdict === 'no_verdict_sentinel') &&
     ALREADY_SHIPPED_RE.test(logTail || '')
   ) {
     return FAILURE_CLASSES.ALREADY_SHIPPED;
   }
   ```

   The verdict gate matters: without it, any run whose tail merely *mentions* "already
   implemented" (e.g. quoting a PRD body) would be misclassified. Add a short comment above the
   block explaining that gate and citing this incident, in the same voice as the existing
   `SELF_QUEUE` comment.

5. Extend `src/main/__tests__/rcaFeedbackHook.test.cjs`, following the existing fixture pattern
   in that file (do not invent a new test style). Add cases:
   - verdict `pass_no_commit` + tail containing `"this work was already committed in 9cf0384"` →
     `already-shipped`
   - verdict `pass_no_commit` + tail containing `"nothing new to commit for this PRD"` →
     `already-shipped`
   - verdict `no_verdict_sentinel` + tail containing a `"Launching skill:
     session-manager-dev:develop"` marker **and** the words "already implemented" → still
     `self-queue` is acceptable ONLY if the gate ordering says so; assert whichever your
     implementation produces and document it in a comment. Prefer ordering `ALREADY_SHIPPED`
     first (as specified above) and assert `already-shipped`.
   - regression: verdict `pass_no_commit` with a tail containing **no** already-shipped phrasing
     still classifies as `no-sentinel` (proves the new check didn't widen `NO_SENTINEL`'s
     coverage)
   - regression: the existing `stuck-loop` and `self-queue` fixtures still classify unchanged

# Verification commands

Run these, in this order, and let the last one be green:

```bash
cd /home/bilko/Projects/session-manager
timeout 300 npm run typecheck
timeout 120 npx vitest run src/main/__tests__/rcaFeedbackHook.test.cjs
test ! -f session-manager-operations/scheduler/prds/812-rca-self-delegation-failure-class.md \
  && echo "ARCHIVED OK" \
  || { echo "HALT: shipped PRD still live in prds/"; exit 1; }
```

# Acceptance criteria

- [ ] `session-manager-operations/scheduler/prds/812-rca-self-delegation-failure-class.md` no
      longer exists in `prds/`; the same filename exists under
      `session-manager-operations/scheduler/prds-archived/`
- [ ] No other file in `session-manager-operations/scheduler/prds/` was moved or deleted
- [ ] `FAILURE_CLASSES.ALREADY_SHIPPED = 'already-shipped'` exists in
      `src/main/lib/rcaFeedbackHook.cjs`
- [ ] `PREVENTION_HINTS[FAILURE_CLASSES.ALREADY_SHIPPED]` exists and names archiving the PRD as
      the corrective action
- [ ] `classifyFailure()` returns `already-shipped` only when the verdict is `pass_no_commit` or
      `no_verdict_sentinel` **and** the tail matches the already-shipped phrasing regex
- [ ] The new check runs before the `SELF_QUEUE` check, and existing `self-queue` / `stuck-loop` /
      `no-sentinel` fixtures still classify unchanged
- [ ] `src/main/__tests__/rcaFeedbackHook.test.cjs` covers all the cases listed in step 5 above
- [ ] `timeout 300 npm run typecheck` passes
- [ ] `timeout 120 npx vitest run src/main/__tests__/rcaFeedbackHook.test.cjs` passes
- [ ] A single commit lands containing both the archive move and the classifier change

# Out of scope

- Re-implementing anything from `9cf0384` (already shipped — verify, don't rewrite)
- Changing `queueOps.cjs`'s `selectAutoArchivable` / `autoArchiveCompleted` retention window or
  its global-vs-project-local archive destination — a real gap, but its own PRD
- Changing `scheduler.cjs`'s verifier, its `pass_no_commit` verdict logic, or the Opus
  investigation spawn path
- Changing how or whether an auto-fix PRD is generated for any failure class

# Engineering standards

The following section is inlined VERBATIM from
`plugins/session-manager-dev/skills/develop/standards.md`. Every rule is mandatory.

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

## One extra note for this specific PRD

**A queued PRD is the task, not evidence of completion — and the deliverable is a code diff.**
Unlike the run that failed, this fix-plan *does* have real work to do: an archive move plus a
classifier change. Do not conclude "already done" and exit without a commit. If you genuinely find
the classifier change already present on `main`, you must still perform and commit the archive
move — that alone satisfies the "a commit landed during the run" requirement.

---
title: "Fix: archive already-shipped 812 PRD + stamp verifier code freshness into run meta.json"
cwd: /home/bilko/Projects/session-manager
parallelGroup: 812
estimateMinutes: 40
---

# Goal

Close out a **false** `pass_no_commit` failure and make its root cause diagnosable from the run
record instead of requiring an Opus investigation.

## Root-cause analysis (read this first — it changes what you should do)

The job that "failed" was PRD `812-commit-guard-retry-on-worktree-ref-visibility-delay`
(run `2026-07-31T08-03-09-530Z`, exit 0, verdict `pass_no_commit` → `needs_review`).

**The executor did nothing wrong.** Its acceptance criteria had already shipped in commit
`d51db78` — *"fix(scheduler): retry commit-guard once before flagging pass_no_commit"*, landed
2026-07-31 00:07 PDT. The re-run at 01:03 PDT correctly found:

- the bounded 2s retry already present in `computeCommittedDuringRun()` at
  `src/main/scheduler.cjs:264-282` (fast path → first `committedInWindow()` → 2000 ms delay →
  one more call, with `COMMIT_GUARD_RETRY_DELAY_MS = 2000`),
- all three required tests already in `src/main/__tests__/scheduler-committed-in-window.test.cjs`
  (6/6 green),
- `npm run typecheck` green,

so it made no change, made no commit, and printed a truthful `SCHEDULER_VERDICT: PASS`.

Two independent defects turned that truthful no-op into a `needs_review` + RCA cycle:

1. **The PRD `.md` was never archived after `d51db78` landed.** It stayed in
   `session-manager-operations/scheduler/prds/`, so it remained queueable and was re-run.

2. **The `pass_no_commit_already_shipped` exemption existed on disk but not in the running
   process.** `runVerify.cjs:902-920` already has exactly this exemption (via
   `extractPrdDeliverablePaths` + `allDeliverablesAlreadyTracked`, `runVerify.cjs:567-612`). It is
   **not broken** — replayed against this exact PRD body it extracts
   `['src/main/scheduler.cjs', 'src/main/__tests__/scheduler-committed-in-window.test.cjs']` and
   `allDeliverablesAlreadyTracked(...)` returns `true`, which would have produced
   `pass_no_commit_already_shipped` instead of `pass_no_commit`. It did not fire because the
   Electron main process hosting the scheduler **booted 2026-07-30 23:51:57 PDT**, ~52 minutes
   BEFORE the exemption landed in commit `253d85e` (00:43 PDT). Main-process CommonJS is loaded
   once at boot; on-disk fixes to `runVerify.cjs` / `scheduler.cjs` do not reach a running
   scheduler until the app is restarted.

Nothing in the run record showed that the verifier was several commits behind `HEAD`, which is why
this cost a full Opus investigation to work out. **Do not re-implement the commit-guard retry and
do not touch the exemption logic — both are correct.** Fix the stale PRD and add the missing
staleness signal.

# Acceptance criteria

- [ ] **Archive the stale PRD.** `git mv`
  `session-manager-operations/scheduler/prds/812-commit-guard-retry-on-worktree-ref-visibility-delay.md`
  → `session-manager-operations/scheduler/prds-archived/` (the directory already exists). Do NOT
  edit its contents. Also `git mv` **this** fix-plan PRD
  (`session-manager-operations/scheduler/prds/812-fix-commit-guard-retry-on-worktree-ref-visibility-delay.md`)
  into `prds-archived/` in the same commit, so neither file can be re-queued after this run.

- [ ] **Stamp verifier code freshness into every run's meta sidecar.** In
  `src/main/scheduler.cjs`, add two module-level constants captured once at module load:
  - `SCHEDULER_BOOTED_AT` — `new Date().toISOString()` evaluated at module load;
  - `SCHEDULER_CODE_SHA` — the short git SHA of `HEAD` in this repo's own source directory at
    module load, resolved with a **bounded** `execFileSync('git', ['-C', __dirname, 'rev-parse', '--short', 'HEAD'], { timeout: 5000, encoding: 'utf8', stdio: ['ignore','pipe','ignore'] })`
    wrapped in try/catch that yields `null` on ANY error (not a git checkout, git missing, timeout).
    This must never throw at module load and must never block the event loop for more than 5 s.

  Write both into the per-run meta sidecar at **both** `writeJson`/`writeJsonSync` call sites for
  `metaPath` in `runJob` (`src/main/scheduler.cjs` — the spawn-error path near line 1731 and the
  normal-exit path near line 1736; grep for `metaPath` to find them, there are exactly two). Keys:
  `schedulerBootedAt` and `schedulerCodeSha`. Add no other keys, and change no existing key.

- [ ] **Regression test for the already-shipped exemption** — add to the existing
  `src/main/__tests__/runVerify.test.cjs` a case that pins the behavior the stale process missed:
  a PRD body naming `src/main/scheduler.cjs` and
  `src/main/__tests__/scheduler-committed-in-window.test.cjs`, a `SCHEDULER_VERDICT: PASS`
  transcript, and `committedDuringRun: false` must yield verdict
  `pass_no_commit_already_shipped` (NOT `pass_no_commit`). Follow the existing tests in that file
  for how `verifyRun` is set up (run dir, prd path, queue entry); reuse their helpers rather than
  writing new fixture scaffolding.

- [ ] **Unit test for the new meta fields** — add a small test (new file
  `src/main/__tests__/scheduler-meta-code-sha.test.cjs`, or extend an existing scheduler test file
  if one already covers meta-sidecar shape) asserting that the scheduler module exports/produces a
  `SCHEDULER_BOOTED_AT` that parses as a valid ISO date, and that `SCHEDULER_CODE_SHA` is either
  `null` or a `/^[0-9a-f]{7,40}$/` string. Export whatever minimal surface the test needs from
  `scheduler.cjs` (`module.exports`), consistent with how the file already exposes helpers for
  tests. If the new file is created, make sure it is picked up by the standing vitest config
  (`vitest.config.ts` — check whether `src/main/__tests__/**` is already globbed before adding an
  entry; do not add a duplicate).

- [ ] `timeout 300 npm run typecheck` passes.
- [ ] `timeout 120 npx vitest run src/main/__tests__/runVerify.test.cjs src/main/__tests__/scheduler-committed-in-window.test.cjs` passes.
- [ ] `timeout 120 npx vitest run src/main/__tests__/scheduler-meta-code-sha.test.cjs` passes (adjust the path if you extended an existing file instead).

# Verification commands

Run these, in this order, and make the last one the final green gate:

```
timeout 300 npm run typecheck
timeout 120 npx vitest run src/main/__tests__/runVerify.test.cjs src/main/__tests__/scheduler-committed-in-window.test.cjs src/main/__tests__/scheduler-meta-code-sha.test.cjs
```

Sanity check the archive step with a negative-assertion-safe form (a bare `ls` on a missing file
exits non-zero and reads as an error to the verifier):

```
if [ -e session-manager-operations/scheduler/prds/812-commit-guard-retry-on-worktree-ref-visibility-delay.md ]; then echo "HALT: stale PRD still queueable"; exit 1; fi; echo "archive clean"
```

# Out of scope

- Re-implementing the commit-guard retry in `computeCommittedDuringRun()` — it already shipped in
  `d51db78` and is verified green. Leave it exactly as-is.
- Changing `extractPrdDeliverablePaths`, `allDeliverablesAlreadyTracked`, or any existing
  `pass_no_commit*` exemption branch in `runVerify.cjs` — they are correct; the running process was
  simply older than they were.
- Any hot-reload / module-reload mechanism for the Electron main process. Out of scope here; the
  new `schedulerCodeSha` field only makes the staleness *visible*, which is all this PRD asks for.
- Editing `~/.claude/session-manager/scheduled-plans/queue.json` by hand — the scheduler owns that
  file and other jobs may be writing it concurrently. The existing `reverifyNeedsReview` rescan
  (`RESCANNABLE_VERDICTS` includes `pass_no_commit`) will self-heal the stale row after the app
  next restarts with current code.
- `reverifyNeedsReview` / `RESCANNABLE_VERDICTS` themselves.

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

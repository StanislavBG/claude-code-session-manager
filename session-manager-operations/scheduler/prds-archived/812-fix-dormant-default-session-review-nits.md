---
title: "Fix: auto-archive a PRD when its job completes, so shipped slugs stop re-firing"
cwd: /home/bilko/Projects/session-manager
parallelGroup: 812
estimateMinutes: 45
---

# Root-cause analysis (read this first — the original PRD did NOT fail)

PRD `812-dormant-default-session-review-nits` ran at 2026-07-31T08:02 PDT and **behaved
correctly**. All four of its acceptance criteria (docstring rewrite in
`src/renderer/lib/createPickedSession.ts`, toast copy in `src/renderer/App.tsx`, the dev warn in
`src/renderer/state/sessions.ts`, the `projects-tab` preset-id comment in
`src/renderer/lib/useKnownProjects.ts`) had **already landed in commit `9c5fbc2`** at 00:05 PDT —
an earlier run of that exact same PRD. The re-run re-read each file, ran `npm run typecheck`
(green), ran `npx vitest run src/renderer/state/__tests__/sessions.test.ts` (16 passed), confirmed
`git status --short` was empty for all four files, correctly declined to fabricate a no-op commit,
and printed a truthful `SCHEDULER_VERDICT: PASS`.

It was nonetheless parked in `needs_review` with verdict `pass_no_commit`, which triggered an Opus
RCA investigation. Two compounding causes:

**Cause 1 — the trigger: a shipped PRD file was never archived.**
`session-manager-operations/scheduler/prds/812-dormant-default-session-review-nits.md` is still
sitting in `prds/` even though its work shipped in `9c5fbc2`. Nothing moves a PRD file to
`prds-archived/` when its job reaches `completed`, so the slug remains re-fireable and the
scheduler re-ran it ~8 hours later. **This is the third occurrence of this exact class in one
day**: `812-rca-self-delegation-failure-class` (fixed by hand-archiving in `26b122d`),
`812-workbench-review-nits-cleanup`, and now this one. Each recurrence burns a full `claude -p`
executor job plus an Opus RCA investigation on a no-op.

**Cause 2 — the misclassification: the verifier fix exists but is not running.**
`src/main/runVerify.cjs` already has a `pass_no_commit_already_shipped` exemption (shipped in
commit `26b122d` at 00:58:58 PDT) that materially checks, via `git ls-files --error-unmatch`,
whether every PRD-named deliverable path is already tracked. It was verified against this exact
PRD body and **would have fired**:

```
$ node -e "const rv=require('./src/main/runVerify.cjs'); ..."
paths: [ 'src/renderer/lib/createPickedSession.ts', 'src/renderer/App.tsx',
         'src/renderer/state/sessions.ts', 'src/renderer/lib/useKnownProjects.ts' ]
allTracked: true
```

It did not fire because the **live scheduler is running pre-fix code**. The Electron process
hosting the scheduler is the npx-installed published build
(`~/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager`, v0.39.1), started
`Thu Jul 30 23:51:57 2026` — 67 minutes *before* `26b122d` landed. Main-process `.cjs` is loaded
once at boot and never hot-reloaded, and the npx build is a separate published artifact from this
working tree, so repo-side verifier fixes reach the running scheduler only after a restart (and,
for the npx build, a publish + `npx …@latest` refresh).

**Conclusion:** Cause 2 is a deployment-latency fact, not a code defect — the code fix is already
correct and committed; nothing to re-fix. The durable code work in this PRD is **Cause 1**:
close the loop so a completed job's PRD file is archived automatically and cannot re-fire.

# Fix steps

## Step 1 — archive the already-shipped PRD file (immediate, unblocks the recurrence)

Move the shipped PRD out of the active queue directory, mirroring what commit `26b122d` did by
hand for `812-rca-self-delegation-failure-class`:

```bash
cd /home/bilko/Projects/session-manager
git mv session-manager-operations/scheduler/prds/812-dormant-default-session-review-nits.md \
        session-manager-operations/scheduler/prds-archived/812-dormant-default-session-review-nits.md
```

Note the source file is currently **untracked** (it shows as `??` in `git status`). If `git mv`
fails for that reason, use a plain `mv` and then `git add` the destination — the destination must
end up tracked so the archive is durable.

Do the same check for any other `812-*` slug whose job is `completed` and whose work has already
landed — inspect `~/.claude/session-manager/scheduled-plans/queue.json` for
`status: "completed"` entries whose `.md` is still in `prds/`, and archive those too. Do **not**
archive PRDs whose status is `pending`, `running`, or `needs_review`.

## Step 2 — auto-archive a PRD file when its job transitions to `completed`

This is the durable fix. In `src/main/scheduler.cjs`:

- The completion transitions are at roughly lines `1315`, `2359`, `3026`, `3059`
  (`job.status = 'completed'` / `orig.status = 'completed'`). Grep for
  `status = 'completed'` and `status: 'completed'` to find the current set — line numbers drift.
- Factor a single helper (e.g. `archiveCompletedPrd(slug, cwd)`) rather than duplicating the move
  at four call sites. Model it on the existing archive logic in the `schedule:clear-queue` IPC
  handler (~line 3259): resolve the PRD dir via `findPrdDir(job.slug) ?? prdDirForCwd(job.cwd)`,
  build the source path, **enforce path containment** (`src.startsWith(srcDir + path.sep)`) exactly
  as that handler does, and `fsp.rename` into `PRDS_ARCHIVE_DIR`. Treat `ENOENT` as a benign no-op
  (already archived / already gone) and log a `warn` line via `logs.writeLine` on any other error.
- The helper must be **non-throwing** — a failed archive must never break job-completion
  bookkeeping. Wrap the call so errors are logged, not propagated.
- Do not archive on `needs_review`, `failed`, or `running` — only on a genuine `completed`
  transition. A `needs_review` PRD must stay in `prds/` so a human or a follow-up run can act on it.
- Keep the existing `resetJob` guard intact (it already refuses to reset a `completed` job without
  `force: true`, ~line 3670) — this change complements it rather than replacing it.

Reuse existing helpers (`findPrdDir`, `prdDirForCwd`, `PRDS_ARCHIVE_DIR`, `config.writeTextAtomic`
where relevant); do not introduce a second archive implementation or a new tmp+rename routine.

## Step 3 — cover it with a unit test

Add tests to the existing scheduler test surface under `src/main/__tests__/` (match the
neighbouring files' style and runner — this repo uses **vitest**, not `node --test`). Cover at
minimum:

- a job transitioning to `completed` moves its `.md` from `prds/` into `prds-archived/`;
- a job transitioning to `needs_review` (or `failed`) leaves the `.md` in place;
- a missing source `.md` (`ENOENT`) is a silent no-op that does not throw or block the status
  transition;
- a slug that would resolve outside the PRD dir is refused by the containment check.

Use a temp directory fixture; do not touch the real `~/.claude/session-manager/` tree.

## Step 4 — do NOT re-fix runVerify.cjs

`src/main/runVerify.cjs`'s `pass_no_commit_already_shipped` exemption is already correct and
already committed. It is out of scope. Note in your completion report that the exemption did not
fire on the 08:02 run purely because the running Electron scheduler predates the commit, and that
picking it up requires an app restart (and, for the npx-published build, a publish). Do not
attempt to restart or publish the app from this headless run.

Note also that `src/main/runVerify.cjs` has **uncommitted working-tree changes** adding a second,
distinct `pass_no_commit_prior_run_verified` exemption. Those are someone else's in-flight work —
leave them alone, do not stage them, and do not include them in your commit. Stage only the files
you actually change.

# Verification

Run these, in this order, before the finish protocol:

```bash
cd /home/bilko/Projects/session-manager
timeout 300 npm run typecheck
timeout 300 npx vitest run src/main/__tests__/
if [ -f session-manager-operations/scheduler/prds/812-dormant-default-session-review-nits.md ]; then
  echo "HALT: shipped PRD still in prds/"; exit 1
fi
echo "archive check clean"
```

The last command must be the green gate — nothing may error after it.

# Acceptance criteria

- [ ] `session-manager-operations/scheduler/prds/812-dormant-default-session-review-nits.md` is no
      longer in `prds/`; the file exists (and is git-tracked) under
      `session-manager-operations/scheduler/prds-archived/`.
- [ ] Any other `812-*` PRD whose queue status is `completed` and whose `.md` is still in `prds/`
      is archived the same way; the completion report lists which slugs were archived and which
      were deliberately left (with their status).
- [ ] `src/main/scheduler.cjs` archives a job's PRD file automatically on the `completed`
      transition, via a single shared non-throwing helper reused across all
      `status = 'completed'` sites, with the same path-containment enforcement used by
      `schedule:clear-queue`.
- [ ] `needs_review` / `failed` / `running` transitions do **not** archive the PRD file.
- [ ] New unit tests under `src/main/__tests__/` cover: archive-on-completed, no-archive-on-
      needs_review, ENOENT no-op, and path-containment refusal.
- [ ] `timeout 300 npm run typecheck` passes.
- [ ] `timeout 300 npx vitest run src/main/__tests__/` passes.
- [ ] The archive check in the Verification block above exits 0.
- [ ] `src/main/runVerify.cjs` is unmodified by this run (its existing exemption is already
      correct); the completion report explains that the 08:02 misclassification was a stale
      running-process issue, not a verifier bug.

# Out of scope

- Any change to `src/main/runVerify.cjs`, including its `pass_no_commit_already_shipped` or the
  uncommitted `pass_no_commit_prior_run_verified` exemption.
- Restarting, rebuilding, or publishing the Electron app.
- Re-doing PRD 812-dormant-default-session-review-nits' original four code edits — they shipped in
  `9c5fbc2` and are verified correct.
- Changing `resetJob`'s completed-job guard.

# Engineering standards

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

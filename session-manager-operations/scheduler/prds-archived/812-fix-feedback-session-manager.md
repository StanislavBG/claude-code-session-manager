---
title: "Fix: sweep-emitted feedback PRDs land in the legacy global dir the runner no longer reads"
cwd: /home/bilko/Projects/session-manager
parallelGroup: 812
estimateMinutes: 40
---

# Goal

Close the PRD-source split-brain that made scheduler job `812-feedback-session-manager` fail with
`exitCode -1` in 450 ms, before any agent ran. Make the feedback-sweep **writer** and the job
**reader** agree on where PRD `.md` files live, and make the reader degrade gracefully to the
legacy dir instead of hard-failing.

# Root-cause analysis (verified, do not re-investigate)

The failure log is a single line:

```
[scheduler] failed to read PRD: ENOENT: no such file or directory, open
  '/home/bilko/Projects/session-manager/session-manager-operations/scheduler/prds/812-feedback-session-manager.md'
```

The PRD file is not missing — it is in the **legacy global** dir:
`~/.claude/session-manager/scheduled-plans/prds/812-feedback-session-manager.md` (mtime Jul 30 23:57).

PRD chain 808→811 moved PRD *sources* out of the global
`~/.claude/session-manager/scheduled-plans/prds/` into each project's
`<cwd>/session-manager-operations/scheduler/prds/` (see `src/main/lib/prdLocations.cjs`). Three
call sites were left on the old side of that move:

1. **Writer never migrated.** `emitFeedbackPRD` in `scripts/lib/watchdogHelpers.cjs:297-355`
   still defaults `prdsDir = DEFAULT_PRDS_DIR` (`watchdogHelpers.cjs:104-106` — the legacy global
   dir), and `src/main/scheduler.cjs:3448` invokes `sweepFeedback()` with **no** `prdsDir` option.
   So the in-app feedback sweep (every 5th 60 s heartbeat tick) writes every new
   `NN-feedback-<project>.md` into the legacy dir, indefinitely.
2. **Reader has no fallback.** `executeJob` reads the body via `prdPathForJob(job)`
   (`src/main/scheduler.cjs:446-448` → `resolvePrdWriteDir(job.cwd)`), which resolves the
   project dir **only**. `findPrdDir(slug)` (`scheduler.cjs:456-464`) already searches every
   candidate dir legacy-first for exactly this reason, but the execute path does not use it.
3. **Migration is boot-only.** `runPrdMigration()` (`scheduler.cjs:517`) relocates legacy files
   once at startup. A file the sweep writes *after* boot is never relocated.

Net effect: **every feedback PRD emitted by the in-app sweep while the app is running is queued
but unrunnable**, and fails with `exitCode -1` the moment it is picked. This is systemic, not a
one-off.

Secondary defect from the same split: `emitFeedbackPRD`'s "next NN" allocator scans only
`prdsDir` (`watchdogHelpers.cjs:339-353`), so with PRDs now living per-project it no longer sees
real slug numbers — the failed run's `812` collides with the existing `parallelGroup 812` batch.

This was **not** a self-delegation failure. The log shows no `Skill` invocation, no
`ScheduleWakeup`, and no agent process at all — the scheduler aborted before spawning `claude -p`.

# Fix steps

Do all four. Each is small and independently testable.

### 1. Writer: emit into the project's own PRDs dir

In `scripts/lib/watchdogHelpers.cjs`, make `emitFeedbackPRD(cwd, opts)` resolve its target dir
from `cwd` when the caller did not pass `prdsDir` explicitly (keep an explicit `prdsDir` override
honored verbatim — the unit tests rely on it, same convention as the existing
`skillPathExplicit` / `standardsPathExplicit` handling at lines 305-314).

Reuse the existing resolver rather than re-deriving the path:
`require('../../src/main/lib/prdLocations.cjs').resolvePrdWriteDir(cwd)` →
`<cwd>/session-manager-operations/scheduler/prds`. (No cycle: `prdLocations.cjs` requires only
`scripts/lib/activeSessions.cjs`.) If you prefer not to cross the `scripts/` → `src/main/`
boundary, re-export `PRD_SUBPATH` and join it — but do **not** hard-code a second copy of the
literal path segments.

`sweep()` (`watchdogHelpers.cjs:618-645`) forwards a single `prdsDir` to every project; change it
so an unset `prdsDir` means "resolve per-cwd" instead of "use the legacy global dir". An
explicitly-passed `prdsDir` must still apply (tests pass a tmpdir).

The `fs.mkdirSync(prdsDir, { recursive: true })` at `watchdogHelpers.cjs:435` already covers a
project dir that does not exist yet — keep it.

### 2. Writer: allocate NN against the real PRD population

The next-NN scan and the `prdDupRe` duplicate check (`watchdogHelpers.cjs:337-353`) must scan the
dir the file will actually be written to (per step 1). That alone fixes the collision, since the
project dir is now the live population.

### 3. Reader: fall back to the legacy dir instead of hard-failing

In `src/main/scheduler.cjs`, at the `executeJob` body read (`~line 1491-1500`), when
`parsePrd(prdPathForJob(job))` throws ENOENT, retry via the existing `findPrdDir(job.slug)` and
parse from there before giving up. Log one line naming the dir it fell back to, e.g.
`[scheduler] PRD not in project dir; found <slug>.md in <dir>` — the fallback must be visible,
not silent. Only if `findPrdDir` also returns null should the job fail as it does today (keep the
existing failure message and `exitCode: -1` path unchanged for that case).

Do the same for the `parsePrdRaw` read in `notifyOriginatingTab` (`scheduler.cjs:1356-1357`) only
if it is a one-line change; it already `.catch(() => null)`s, so it is not load-bearing — skip it
if it adds risk.

### 4. Relocate the currently-stranded files

`runPrdMigration()` is idempotent and already does exactly this. Make the feedback sweep path
benefit from it: either call `runPrdMigration()` immediately before `sweepFeedback()` in the
heartbeat tick (`scheduler.cjs:~3448`), or leave migration boot-only — but in **either** case the
already-stranded file must be moved as part of this PRD. Move it with `git mv`-equivalent shell
(it is outside the repo, so plain `mv`):

```
timeout 30 node -e "require('/home/bilko/Projects/session-manager/src/main/lib/prdMigration.cjs').migratePrds('/home/bilko/.claude/session-manager/scheduled-plans/prds').then(r => console.log(JSON.stringify(r)))"
```

Then confirm `812-feedback-session-manager.md` now exists under
`/home/bilko/Projects/session-manager/session-manager-operations/scheduler/prds/`. Do **not**
hand-edit `queue.json` and do **not** try to re-run the failed job — the scheduler owns that.

### Tests

Add/extend unit tests next to the existing watchdog-helper and scheduler tests (find them with
`timeout 60 grep -rl "emitFeedbackPRD\|prdPathForJob" --include=*.spec.* --include=*.test.* .`):

- `emitFeedbackPRD(cwd)` with **no** `prdsDir` writes to `<cwd>/session-manager-operations/scheduler/prds/`.
- `emitFeedbackPRD(cwd, { prdsDir })` with an explicit dir still writes there (regression guard).
- A slug present only in the legacy dir is still resolvable by the reader fallback (`findPrdDir`
  returns the legacy dir; the execute-path helper resolves a body).

# Verification

Run all of these; every one must be green, and run the AC gate **last**:

```
timeout 300 npm run typecheck
timeout 300 npm run test:unit
timeout 60 git diff --exit-code
```

Plus this direct check that the class of failure is gone (negative assertion — note it must exit 0
when clean):

```
if ls /home/bilko/.claude/session-manager/scheduled-plans/prds/*-feedback-*.md >/dev/null 2>&1; then
  echo "HALT: feedback PRDs still stranded in the legacy global dir"; exit 1;
fi; echo "clean: no stranded feedback PRDs"
```

# Acceptance criteria

- [ ] `emitFeedbackPRD` / `sweep` write feedback PRDs to `<cwd>/session-manager-operations/scheduler/prds/` when no explicit `prdsDir` is passed; an explicit `prdsDir` is still honored.
- [ ] Next-NN allocation and the duplicate check scan that same per-project dir.
- [ ] `executeJob`'s PRD-body read falls back to `findPrdDir(job.slug)` on ENOENT and logs the fallback dir; only a genuinely missing slug fails the job.
- [ ] `812-feedback-session-manager.md` has been relocated out of the legacy global dir into `/home/bilko/Projects/session-manager/session-manager-operations/scheduler/prds/`, and no `*-feedback-*.md` remains in the legacy dir.
- [ ] New unit tests cover the default-dir write, the explicit-dir override, and the legacy-dir reader fallback.
- [ ] `timeout 300 npm run typecheck` and `timeout 300 npm run test:unit` both pass.
- [ ] Work is committed; `timeout 60 git diff --exit-code` is clean.

# Out of scope

- Re-running or re-queuing the failed `812-feedback-session-manager` job (the scheduler owns that).
- Actually processing the session-manager feedback folder (that is what the repaired job will do).
- Any further part of the 808→811 per-project-PRD chain beyond the three call sites named above.

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

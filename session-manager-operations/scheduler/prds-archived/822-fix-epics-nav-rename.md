---
title: "Fix: treat an archived PRD as a stale-skip, not an exit -1 job failure"
cwd: /home/bilko/Projects/session-manager
parallelGroup: 822
estimateMinutes: 35
---

# Goal

Make the scheduler recognize that a queued job whose PRD `.md` has been moved into the
sibling `prds-archived/` directory is **already done**, and retire that job cleanly instead
of failing it with `exitCode: -1` and an ENOENT error.

# Root-cause analysis (what went wrong, and why)

Scheduled job `822-epics-nav-rename` (run
`~/.claude/session-manager/scheduled-plans/runs/2026-07-31T16-35-37-502Z/`) failed with exit
code `-1`. The entire run log is three lines:

```
[scheduler] starting 822-epics-nav-rename at 2026-07-31T16:35:46.778Z
[scheduler] cwd=/home/bilko/Projects/session-manager

[scheduler] failed to read PRD: ENOENT: no such file or directory, open
  '/home/bilko/Projects/session-manager/session-manager-operations/scheduler/prds/822-epics-nav-rename.md'
```

No `claude -p` child was ever spawned. The failure happened in `executeJob`, before the
prompt was built.

The PRD file was not lost — **the work had already shipped and the PRD had been archived**:

- Commit `2ca124f` — "feat(epics): rename Projects to Epics, wire PRD-dispatch traceability,
  retire default legacy tab UI" (Fri Jul 31 09:23 PDT) — landed exactly this PRD's acceptance
  criteria (nav label, page heading, "Back to Epics", the new "Epic Queue" section).
- The PRD body now lives at
  `session-manager-operations/scheduler/prds-archived/822-epics-nav-rename.md` (mtime 08:41).
- The scheduler nonetheless fired the still-queued job for that slug at 16:35 UTC.

So the defect is a **reconciliation gap between archiving a PRD file and the queue entry that
points at it**:

1. `archiveCompletedPrd(slug, cwd)` (`src/main/scheduler.cjs:525`), `archiveOne`
   (`src/main/queueOps.cjs:294`) and `autoArchiveCompleted` (`src/main/queueOps.cjs:396`)
   all move `<prdsDir>/<slug>.md` → `<prdsDir>/../prds-archived/<slug>.md`. None of them
   ensures a still-queued job for that slug stops being runnable.
2. `executeJob`'s PRD-read fallback (`src/main/scheduler.cjs` ~1693-1723) tries
   `prdPathForJob(job)`, then falls back to `findPrdDir(job.slug)` — which searches only the
   candidate **`prds/`** dirs (`candidatePrdsDirs()`), never the sibling `prds-archived/`.
   When both miss, it returns `{ exitCode: -1, error: <ENOENT message> }`, which is
   classified as a genuine job failure and pulls in the RCA-feedback machinery.

An archived PRD is the single most common "PRD file legitimately absent" case, and it means
"already completed", not "broken job". The scheduler currently has no way to say so.

# Fix

Two changes, both in the main process. Do **both** — the guard makes the failure impossible,
the source-side reconciliation stops the stale entry from surviving in the first place.

## 1. `src/main/scheduler.cjs` — recognize the archived twin in `executeJob`

- Add a small pure helper next to `prdPathForJob` (~line 468) and export it from the module's
  existing test-surface exports (follow whatever export shape the sibling helpers already use
  in this file — check the bottom-of-file `module.exports` and mirror it exactly):

  ```js
  /** Absolute path to the sibling `prds-archived/<slug>.md` twin of a job's PRD. */
  function archivedPrdPathForJob(job) {
    return path.join(prdDirForCwd(job && job.cwd), '..', 'prds-archived', `${job && job.slug}.md`);
  }
  ```

  Keep it pure (path math only, no fs) so it is directly unit-testable.

- In `executeJob`'s PRD-read `catch` block (the branch that currently logs
  `[scheduler] failed to read PRD:` when `findPrdDir` returns null), **before** returning the
  `exitCode: -1` failure, check whether the archived twin exists. If it does, this is a stale
  queue entry for already-shipped work. Log one clear line and return a non-failure result:

  ```js
  const archivedTwin = archivedPrdPathForJob(job);
  let isArchived = false;
  try { await fsp.access(archivedTwin); isArchived = true; } catch { /* not archived */ }
  if (isArchived) {
    const msg = `PRD already archived (${archivedTwin}) — work shipped; retiring stale queue entry`;
    safeLog(`[scheduler] ${msg}\n`);
    closeFd();
    config.writeJsonSync(metaPath, {
      slug: job.slug, cwd, sessionId, exitCode: 0, skipped: 'prd-archived',
      note: msg, startedAt, finishedAt: Date.now(), durationMs: 0,
    });
    return { exitCode: 0, durationMs: 0, skipped: 'prd-archived', note: msg, sessionId };
  }
  ```

  Apply the same guard to **both** failure exits in that block (the `catch (e2)` inner one and
  the `else` outer one) — factor the check into one local helper rather than duplicating it.

- In `spawnJob` (~line 2255, where `const res = await executeJob(...)` is consumed): when
  `res.skipped === 'prd-archived'`, mark the job **completed** using the existing
  completion path, and do **not** route it through the failure/RCA-feedback path. Read the
  surrounding code first and reuse whatever status-mutation and history-append helpers are
  already there — do not invent a new job status value, and do not add a new queue field
  beyond a note/reason string if one already exists for this purpose. If there is genuinely
  no existing note field, completing the job silently (with the run-log line above as the
  record) is acceptable; do not grow the queue schema for this.

## 2. Source-side reconciliation

Make archiving a PRD retire its queue entry, so no stale job can survive to a later tick:

- In `src/main/scheduler.cjs`'s `archiveCompletedPrd`, this is already the completion path,
  so nothing more is needed there — verify that and note it.
- In `src/main/queueOps.cjs`'s `archiveOne` / `archiveMany` (manual `schedule:archive-prd`)
  and `autoArchiveCompleted`: after a successful move, ensure any queue job for that slug
  that is still in a runnable (pending) state is marked completed rather than left runnable.
  Reuse the state-mutation helper those functions already have access to
  (`autoArchiveCompleted` already receives `state`). If `archiveOne` has no access to queue
  state without a new dependency, thread it in the same way `autoArchiveCompleted` does —
  do not import `scheduler.cjs` from `queueOps.cjs` (circular).

Keep the change minimal and behavior-preserving for every other path.

# Tests (TDD — write these first, watch them fail, then implement)

Create `src/main/__tests__/scheduler-archived-prd-skip.test.cjs`, modeled on the existing
`src/main/__tests__/scheduler-archive-completed-prd.test.cjs` (same tmpdir + require pattern):

1. `archivedPrdPathForJob` resolves to `<prdsDir>/../prds-archived/<slug>.md` for a job with a
   given `cwd`, and does not escape that directory for a well-formed slug.
2. Given a tmp project where `prds/<slug>.md` does NOT exist but
   `prds-archived/<slug>.md` DOES, the PRD-read path yields the stale-skip result
   (`skipped === 'prd-archived'`, `exitCode === 0`) rather than an `exitCode: -1` ENOENT
   failure. If `executeJob` cannot be driven directly in a unit test, extract the
   archived-twin check into a small exported pure-ish helper (e.g.
   `async function archivedTwinExists(job)`) and test that plus the branch selection — do not
   spawn a real `claude -p`.
3. Given a tmp project where NEITHER `prds/<slug>.md` nor `prds-archived/<slug>.md` exists,
   behavior is unchanged: still a hard failure. This guards against the fix swallowing real
   missing-PRD bugs.

Add a queueOps case (extend `src/main/__tests__/queueOpsAutoArchive.test.cjs` or add a
sibling file) asserting that archiving a slug leaves no runnable queue job for that slug.

# Verification commands

Run these, in this order, and end on a green gate:

```
timeout 300 npm run typecheck
timeout 120 npx vitest run src/main/__tests__/scheduler-archived-prd-skip.test.cjs 2>&1 | tail -30
timeout 180 npx vitest run src/main/__tests__/ 2>&1 | tail -40
timeout 60 npm run lint:selectors
```

Then confirm the real-world case reads correctly (negative-assertion form — must exit 0 when
clean):

```
if [ ! -f session-manager-operations/scheduler/prds-archived/822-epics-nav-rename.md ]; then
  echo "HALT: expected archived twin missing — fixture assumption broken"; exit 1
fi
echo "archived twin present as expected"
```

Do **not** hand-edit the live queue (`~/.claude/session-manager/scheduled-plans/queue.json`)
and do **not** re-queue `822-epics-nav-rename` — its work already landed in `2ca124f`. The
fix is the code path, not the one stale row.

# Acceptance criteria

- [ ] `src/main/scheduler.cjs` gains a pure `archivedPrdPathForJob(job)` helper resolving to
      the job's sibling `prds-archived/<slug>.md`, exported on the module's existing test
      surface.
- [ ] `executeJob`'s PRD-read failure path checks for the archived twin **before** returning
      `exitCode: -1`, on both the inner (`catch (e2)`) and outer (`else`) exits, and returns
      `{ exitCode: 0, skipped: 'prd-archived', ... }` with a `[scheduler] PRD already
      archived ...` log line when the twin exists.
- [ ] The run meta JSON for a stale-skip records `skipped: 'prd-archived'` and `exitCode: 0`.
- [ ] `spawnJob` treats a `skipped === 'prd-archived'` result as job completion, not failure —
      no RCA-feedback emission, no `needs_review`.
- [ ] Archiving a PRD via `queueOps.archiveOne`/`archiveMany`/`autoArchiveCompleted` leaves no
      runnable queue job for that slug.
- [ ] A missing PRD with **no** archived twin still fails hard exactly as before (regression
      guard test present and passing).
- [ ] `src/main/__tests__/scheduler-archived-prd-skip.test.cjs` exists and passes.
- [ ] `timeout 300 npm run typecheck` passes.
- [ ] `timeout 180 npx vitest run src/main/__tests__/` shows no new failures.
- [ ] `timeout 60 npm run lint:selectors` passes.
- [ ] No edits to `~/.claude/session-manager/scheduled-plans/queue.json` and no re-queue of
      `822-epics-nav-rename`.

# Out of scope

- Re-doing the Epics rename itself — it shipped in commit `2ca124f`. This PRD is scheduler
  reconciliation only. Do not touch `src/renderer/**`.
- Changing `findPrdDir` / `candidatePrdsDirs` to include `prds-archived/` globally. That would
  let the scheduler *run* archived PRDs, which is the opposite of the fix.
- The stranded legacy-dir PRD migration health check (PRD 821) — related area, separate work.

## Engineering standards

The following is inlined verbatim from
`plugins/session-manager-dev/skills/develop/standards.md`, section
`## Execution discipline (headless runs)`. Every rule is mandatory.

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

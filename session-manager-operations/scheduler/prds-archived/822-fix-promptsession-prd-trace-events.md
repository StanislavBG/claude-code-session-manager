---
title: "Fix: retire stale queue rows whose PRD was archived out-of-band instead of failing them"
cwd: /home/bilko/Projects/session-manager
parallelGroup: 822
estimateMinutes: 20
---

# Context: what failed and why

Job `822-promptsession-prd-trace-events` failed with exit code -1. Its run log
(`~/.claude/session-manager/scheduled-plans/runs/2026-07-31T16-35-37-502Z/822-promptsession-prd-trace-events.log`)
is three lines long:

```
[scheduler] starting 822-promptsession-prd-trace-events at 2026-07-31T16:35:46.780Z
[scheduler] cwd=/home/bilko/Projects/session-manager
[scheduler] failed to read PRD: ENOENT: no such file or directory, open '/home/bilko/Projects/session-manager/session-manager-operations/scheduler/prds/822-promptsession-prd-trace-events.md'
```

No `claude -p` child was ever spawned. `executeJob` (`src/main/scheduler.cjs`, ~line 1705)
aborted at its "read full PRD body fresh from disk" step.

## Root cause

**The PRD's work had already shipped, and its `.md` had been archived out-of-band, but the
queue row was never retired.**

- Commit `2ca124f` — *"feat(epics): rename Projects to Epics, wire PRD-dispatch traceability,
  retire default legacy tab UI"*, 2026-07-31 09:23 PT — implemented this PRD's acceptance
  criteria inline from the interactive session. It touched exactly the PRD's targets:
  `src/renderer/components/PromptSessionConversation.tsx`, `src/renderer/state/chat.ts`,
  `src/renderer/components/TerminalChat.tsx`, and added
  `src/renderer/components/__tests__/PromptSessionConversation.test.tsx`.
- The PRD file was hand-moved at 08:42 PT to
  `session-manager-operations/scheduler/prds-archived/822-promptsession-prd-trace-events.md`
  — note it sits **flat** in `prds-archived/`, not under an `<ISO-timestamp>/` subdirectory,
  which is the signature of a manual `mv` rather than `queueOps.cjs`'s `archiveMany`
  (that mover always creates `prds-archived/<ISO>/`).
- The queue entry in `~/.claude/session-manager/scheduled-plans/queue.json` was left
  `pending`. At 09:35 PT the scheduler dispatched it. `prdPathForJob` resolved the live
  project dir (file gone), and the `findPrdDir` fallback correctly does **not** search
  `prds-archived/`, so both lookups missed and the job returned `{ exitCode: -1 }`.

**Therefore: do NOT re-execute the original PRD's feature work. It is already committed.**
The bug to fix is the scheduler's handling of a queue row whose PRD has been archived: it
currently surfaces as a hard execution failure (exit -1) and triggers the RCA/auto-fix
machinery, when it should be recognized as "already shipped — retire this row cleanly".

## IMPORTANT: partial fix may already exist in the working tree

At investigation time, `src/main/scheduler.cjs` had an **uncommitted** 44-line addition
(`git diff --stat src/main/scheduler.cjs` → `44 ++++`) adding:

- `archivedPrdPathForJob(job)` — resolves the sibling `prds-archived/<slug>.md` twin
- `archivedTwinExists(job)` — async existence check for that twin
- `prdArchivedSkipResult(...)` (~line 497) — logs
  `PRD already archived (...) — work shipped; retiring stale queue entry`, writes a meta
  sidecar with `exitCode: 0, skipped: 'prd-archived'`, and returns that result
- two call sites in `executeJob`'s PRD-read catch block (~lines 1755 and 1763) that return
  `prdArchivedSkipResult(...)` before the `failed to read PRD` / exit -1 path

That work most likely came from the concurrently-running sibling job
`822-fix-epics-nav-rename` (same root cause, same file). **Your first step is to check what
is already present — committed or uncommitted — and only add what is missing.** Do not
revert, duplicate, or re-implement those helpers. This PRD is explicitly idempotent about
that prior work; its job is to make sure the guard is committed, tested, and that the
stale queue rows are actually retired.

# Concrete fix steps

## Step 0 — survey current state (do this first)

```bash
cd /home/bilko/Projects/session-manager
git log --oneline -5
git status --short src/main/scheduler.cjs
grep -n "archivedTwinExists\|prdArchivedSkipResult\|archivedPrdPathForJob" src/main/scheduler.cjs
ls -la session-manager-operations/scheduler/prds-archived/822-promptsession-prd-trace-events.md
```

Branch on what you find:

- Helpers present **and committed** → skip Step 1, go to Step 2.
- Helpers present but **uncommitted** in the working tree → keep them, review them against
  Step 1's spec, adjust only if they diverge, and commit them as part of your commit.
- Helpers **absent** → implement Step 1.

If a concurrent job is mid-flight in this repo, follow the shared-`cwd` rule in
`## Engineering standards` below: check `git status` / `git stash list` first, and never
discard working-tree state you did not create.

## Step 1 — the archived-twin guard in `src/main/scheduler.cjs`

Only if not already present. Add near the existing `findPrdDir` (~line 510):

```js
/** Absolute path to the sibling `prds-archived/<slug>.md` twin of a job's PRD. */
function archivedPrdPathForJob(job) {
  return path.join(prdDirForCwd(job && job.cwd), '..', 'prds-archived', `${job && job.slug}.md`);
}

/**
 * True if a job's PRD has already been archived (sibling `prds-archived/<slug>.md`
 * exists). A queue entry whose PRD moved there is stale — the work already shipped
 * — not a genuine missing-PRD failure.
 */
async function archivedTwinExists(job) {
  try {
    await fsp.access(archivedPrdPathForJob(job));
    return true;
  } catch {
    return false;
  }
}
```

Plus a single shared result builder (one implementation, not one per call site — the
API-reuse standard) that logs the reason, closes the fd, writes the meta sidecar with
`exitCode: 0` + `skipped: 'prd-archived'`, and returns it. Wire it into **both** failure
branches of `executeJob`'s PRD-read `catch` (~lines 1741-1769), checked *before* the
`safeLog('[scheduler] failed to read PRD: ...')` / `return { exitCode: -1 }` lines.

Constraints:
- Use `fsp.access`, not `fs.existsSync` — the surrounding code is async.
- Do not make `findPrdDir` search `prds-archived/`. That would let a genuinely archived PRD
  be re-executed, which is exactly the behavior the archive exists to prevent.
- `prdDirForCwd` already handles the per-project path; do not hard-code `PRDS_ARCHIVE_DIR`
  (that is the *legacy global* dir; per-project PRDs archive to their own sibling — see the
  `archiveCompletedPrd` docstring at ~line 530 for the same reasoning).

## Step 2 — export for tests

Ensure `archivedTwinExists` (and `archivedPrdPathForJob`) appear in `scheduler.cjs`'s
`module.exports` object at the bottom of the file (~line 3990), alongside the existing
`archiveCompletedPrd`, `prdPathForJob`, `findPrdDir` exports. `prdArchivedSkipResult`
takes fd/log closures and is awkward to unit-test directly — exporting the predicate is
sufficient.

## Step 3 — TDD unit test (red first)

Add to `src/main/__tests__/` — extend the existing
`src/main/__tests__/scheduler-archive-completed-prd.test.cjs` if it fits cleanly, otherwise
create `src/main/__tests__/scheduler-archived-twin-guard.test.cjs`. Follow that existing
file's tmpdir + `prdDirForCwd`-shaped fixture setup; do not invent a new fixture idiom.

Cases (write them failing first if Step 1's code is absent):

1. `archivedTwinExists({ slug, cwd })` returns `true` when
   `<cwd>/session-manager-operations/scheduler/prds-archived/<slug>.md` exists and
   `prds/<slug>.md` does not.
2. Returns `false` when neither file exists (a genuinely missing PRD must still fail loudly
   with exit -1 — this is the regression that matters most).
3. Returns `false` for a slug whose archived twin belongs to a *different* cwd.

## Step 4 — retire the two stale queue rows

Queue state lives at `~/.claude/session-manager/scheduled-plans/queue.json`. Inspect it for
rows whose slug's `.md` no longer exists in the project `prds/` dir but does exist in
`prds-archived/`:

```bash
python3 - <<'PY'
import json, os
p = os.path.expanduser('~/.claude/session-manager/scheduled-plans/queue.json')
q = json.load(open(p))
for j in q.get('jobs', []):
    print(j.get('slug'), j.get('status'), j.get('cwd'))
PY
```

If `822-promptsession-prd-trace-events` (or `822-epics-nav-rename`) still has a
non-terminal row, remove it. **Do not hand-edit `queue.json` while the Electron app is
running** — it owns that file and will clobber your write. Two safe options, in order of
preference:

1. Prefer the app's own surface: `schedule:archive-prd` / the SchedulePanel archive action,
   or the loopback admin API (`scripts/scheduler-mcp-server.cjs` → `scheduler_list_jobs`,
   which only works while the app is running).
2. If the app is not running, back up (`cp queue.json queue.json.bak-manual`) and edit,
   preserving the existing schema exactly.

If neither is possible in your run (app state ambiguous), **say so explicitly in your finish
output and skip this step** — Steps 1-3 are the code fix and are what the acceptance gate
checks. Do not block the run on it, and do not fabricate having done it.

## Step 5 — do NOT re-do the original feature work

`PromptSessionConversation.tsx`'s PRD-dispatch composer and inline `prd_created`/`closed`
event rendering already landed in `2ca124f`. Confirm cheaply and move on:

```bash
grep -n "prd_created" src/renderer/components/PromptSessionConversation.tsx
```

If matches appear (they did at investigation time, ~lines 72-176), the feature is shipped.
Do not re-implement, re-style, or "improve" it — that is outside this PRD's acceptance
criteria (see the "Stay in the AC" rule below).

# Verification commands

Run these; the acceptance gate must be the LAST thing in the run and must be green:

```bash
cd /home/bilko/Projects/session-manager
timeout 300 npm run typecheck
timeout 300 npm run lint:selectors
timeout 180 npx vitest run src/main/__tests__/scheduler-archive-completed-prd.test.cjs src/main/__tests__/scheduler-archived-twin-guard.test.cjs
timeout 420 npm run test:unit
```

(If you extended the existing test file rather than adding a new one, drop the non-existent
path from the targeted vitest line rather than letting it error.)

Negative-assertion sanity check — the guard must not have made a genuinely-missing PRD
silent. Note the inversion so the clean path exits 0:

```bash
if grep -n "failed to read PRD" src/main/scheduler.cjs > /dev/null; then
  echo "OK: hard-failure path for genuinely missing PRDs is still present"
else
  echo "HALT: the exit -1 path for a truly missing PRD was removed — that is a regression"
  exit 1
fi
```

# Acceptance criteria

- [ ] `src/main/scheduler.cjs` contains an archived-twin guard: a job whose PRD `.md` is
      absent from every live PRDs dir but present as `<cwd>/session-manager-operations/scheduler/prds-archived/<slug>.md`
      returns `exitCode: 0` with `skipped: 'prd-archived'`, logs one clear line naming the
      archived path, and writes its meta sidecar — instead of `exitCode: -1`.
- [ ] Both PRD-read failure branches in `executeJob` (the `findPrdDir`-fallback-failed branch
      and the no-fallback-dir branch) go through **one** shared result builder, not two copies.
- [ ] A genuinely missing PRD (no live file, no archived twin) still fails loudly with
      `exitCode: -1` and the `[scheduler] failed to read PRD:` log line. Covered by a test.
- [ ] `findPrdDir` still does NOT search `prds-archived/` — archived PRDs must remain
      un-runnable.
- [ ] `archivedTwinExists` is exported from `scheduler.cjs` and covered by unit tests for the
      three cases in Step 3 (archived twin present → true; nothing anywhere → false;
      twin under a different cwd → false).
- [ ] Any pre-existing uncommitted implementation of this guard found in the working tree is
      preserved and committed, not reverted or duplicated.
- [ ] No changes to `PromptSessionConversation.tsx`, `chat.ts`, or `TerminalChat.tsx` — that
      feature work already shipped in `2ca124f`.
- [ ] `timeout 300 npm run typecheck` passes.
- [ ] `timeout 300 npm run lint:selectors` passes.
- [ ] `timeout 420 npm run test:unit` passes.
- [ ] Work is committed and the run ends with a truthful `SCHEDULER_VERDICT: PASS`.

# Out of scope

- Re-implementing the Epic/PromptSession PRD-dispatch + traceability feature (shipped).
- Changing `queueOps.cjs`'s `autoArchiveCompleted` selection predicate or retention window.
- Any UI for archived-PRD queue rows.
- Adding `prds-archived/` to `findPrdDir`'s search path.
- Retention/cleanup of `prds-archived/` itself.

## Engineering standards

Inlined verbatim from `plugins/session-manager-dev/skills/develop/standards.md`.

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

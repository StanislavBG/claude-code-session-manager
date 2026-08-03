---
title: "Fix: exempt subagent-internal tool errors from the verifier's is_error scan"
cwd: /home/bilko/Projects/session-manager
parallelGroup: 955
estimateMinutes: 25
---

# Context: the original job did NOT fail

PRD `955-route-epic-create-through-ipc` ran on 2026-08-03T00:31Z, exited 0, and **its work
landed correctly**. Commit `ba54269` ("feat(epics): route createPromptSession through main's
ensureEpic IPC") converted `createPromptSession` to call `window.api.promptSessions.create`,
updated every real and test call site, and removed the dead `buildPromptSession` helper.
Verified on HEAD at investigation time:

- `npm run typecheck` → exit 0.
- `npx vitest run src/renderer/state/__tests__/promptSessions.test.ts src/renderer/components/epics/__tests__ src/renderer/components/__tests__/EpicsWorkspace.test.tsx tests/unit/promptSessionSchema-crossBoundary.spec.ts` → **15 files, 178 tests, all passing**.

So this fix-plan is **not** about redoing PRD 955's feature work. Do not re-implement it.
This PRD fixes the **verifier false positive** that parked a green run in `needs_review`.

# Root-cause analysis

The run was downgraded by `src/main/runVerify.cjs` with:

```
{"verdict":"transcript_errors","reason":"is_error=true in final 20% of transcript (event 450/499)","downgradeTo":"needs_review"}
```

Two compounding causes:

## Cause 1 (primary) — subagent-internal tool errors downgrade the parent run

The offending transcript event (log line 840 of
`/home/bilko/.claude/session-manager/scheduled-plans/runs/2026-08-03T00-31-05-586Z/955-route-epic-create-through-ipc.log`)
is a `grep` that exited **1 because it found no matches**, and it ran **inside a
`code-reviewer` Task subagent**, not in the main agent's own execution. The raw event carries
`"parent_tool_use_id":"toolu_01RhLPnvenxmZxZv4txwruDF"` and
`"subagent_type":"code-reviewer"`.

`runVerify.cjs`'s tool-result scan already knows subagent output is a false-positive source —
line ~805 skips `toolUseName(events, ev.toolUseId) === 'Task'` for the **content-pattern**
scan, with a comment citing feedback 2026-06-10-01. But that `continue` sits **after** the
`is_error` branch at line ~787:

```js
// is_error:true in the final 20% of the transcript.
if (ev.isError && i >= last20pctStart) { ...push transcript_errors... }

if (!ev.content) continue;
if (toolUseName(events, ev.toolUseId) === 'Task') continue;   // ← too late
```

So the exemption never applies to `is_error`. Worse, `parseLog` (line ~149) does not record
`parent_tool_use_id` at all, so the scanner has **no way** to distinguish a main-agent tool
error from an error that happened inside a delegated subagent's own exploratory work. A
subagent doing normal exploratory `grep`s (which exit 1 on no-match by design) can therefore
downgrade a perfectly green parent run — exactly what happened here.

## Cause 2 (contributing) — no `SCHEDULER_VERDICT` sentinel was emitted

The string `SCHEDULER_VERDICT` appears **nowhere** in the 3 MB run log. `runVerify.cjs` has an
authoritative override (line ~1000):

```js
if (sentinel === 'pass' && committedDuringRun
    && (top.verdict === 'transcript_errors' || top.verdict === 'verify_unavailable')) {
  return conclude('clean', `SCHEDULER_VERDICT: PASS + commit landed overrides ${top.verdict}`, ...)
}
```

A commit **did** land during the run, so had the executor honored the finish protocol and
printed `SCHEDULER_VERDICT: PASS` as its last line, this override would have fired and the job
would have been marked `clean` despite the noise. With `sentinel === null` the override could
not apply and `transcript_errors` (priority 2) won.

Cause 2 is an executor-discipline problem the inlined standards below already cover; the code
change in this PRD targets Cause 1, which is a real defect in the verifier.

# Fix steps

All edits are in `src/main/runVerify.cjs` and its test file. Write the failing test first
(TDD, per the standards block below).

## Step 1 — capture `parent_tool_use_id` in `parseLog`

In `src/main/runVerify.cjs`, `parseLog()` (~line 149) builds two event kinds. Add the parent
id to both, read from the **top-level** stream-json object (`obj.parent_tool_use_id`), not
from the content item:

- In the `obj.type === 'assistant'` branch, on each pushed `kind: 'tool_use'` event, add
  `parentToolUseId: obj.parent_tool_use_id ?? null`.
- In the `obj.type === 'user'` branch, on each pushed `kind: 'tool_result'` event, add
  `parentToolUseId: obj.parent_tool_use_id ?? null`.

Update the event-shape doc comment at ~line 139 to list the new field.

## Step 2 — exempt subagent-internal tool_results from the `is_error` scan

In the scan loop (~line 780), **before** the `if (ev.isError && i >= last20pctStart)` check,
add:

```js
// A tool_result carrying a non-null parent_tool_use_id happened INSIDE a Task
// subagent's own execution, not in the main agent's. Subagents do ordinary
// exploratory work (greps that exit 1 on no-match, ls on a path that may not
// exist) whose failures say nothing about whether the parent run succeeded —
// the same false-positive class the Task exemption below already covers for the
// content-pattern scan, which sits after this branch and so never reached
// is_error. The subagent's OWN final Task tool_result has parentToolUseId ===
// null and is still scanned, so a genuinely failed subagent still surfaces.
// (Incident: 955-route-epic-create-through-ipc, 2026-08-03 — a fully green,
// committed run parked in needs_review over a code-reviewer subagent's
// no-match grep at event 450/499.)
if (ev.parentToolUseId) continue;
```

Place it after the existing `isHarnessToolError(ev.content)` exemption so the ordering reads:
harness errors → subagent-internal → is_error → content patterns. Note this `continue` skips
the content-pattern scan for subagent-internal results too, which is correct and consistent
with the existing `Task` exemption (that exemption can stay as-is; it still covers the
subagent's own final result).

## Step 3 — tests

Add to `src/main/__tests__/runVerify.test.cjs`, following the file's existing fixture style
(write a temp stream-json log, call the verify entry point, assert the verdict):

1. **Regression (the actual incident shape):** a log where the run commits, the final `result`
   event has `subtype: 'success'`, and a `tool_result` with `"is_error":true` **and a non-null
   `parent_tool_use_id`** appears in the final 20% → verdict is **not** `transcript_errors`.
2. **Guard against over-exemption:** the same log but with `parent_tool_use_id: null` on that
   error event → verdict **is** `transcript_errors` (the existing behavior must be preserved
   for main-agent errors).
3. **parseLog unit:** assert `parseLog` populates `parentToolUseId` on both `tool_use` and
   `tool_result` events, and `null` when the field is absent.

Check whether `parseLog` / the scan entry point are already exported at the bottom of
`runVerify.cjs` (`toolUseName` is exported at ~line 1049); reuse whatever the existing tests
import rather than adding a new export if one already serves.

## Step 4 — stale-comment cleanup from PRD 955 (small, do it in the same commit)

PRD 955 retired the renderer's `buildPromptSession`, but two comments still describe it as
live. Correct both to say the renderer no longer constructs a `PromptSession` and that
**PRD 955** (not 954) retired it:

- `src/main/lib/epicMint.cjs:225` — "mirrors the renderer's own buildPromptSession".
- `tests/unit/promptSessionSchema-crossBoundary.spec.ts`, header comment (~line 7) — says
  "PRD 954 retired the renderer-side construction"; it was PRD 955 / commit `ba54269`.

Comment-only edits; no behavior change.

## Explicitly out of scope

- Re-implementing PRD 955's feature work — it landed in `ba54269` and is green. Do not touch
  `src/renderer/state/promptSessions.ts` or its call sites.
- Any broader change to `runVerify.cjs`'s heuristics: do **not** add a "benign `grep` exit 1"
  or "`ls` ENOENT" exemption for MAIN-agent tool errors. Executors are already required
  (standards, "Negative-assertion checks must exit 0 when clean") to invert those; loosening
  the main-agent scan would weaken the false-PASS guard.
- Changing the sentinel-override logic (~line 1000). It is correct; the original run simply
  never emitted the sentinel.
- Re-running or resetting the original `955-route-epic-create-through-ipc` queue entry.

# Verification commands

Run each, bounded, and end on the green gate:

```bash
timeout 300 npm run typecheck
timeout 300 npx vitest run src/main/__tests__/runVerify.test.cjs
timeout 300 npx vitest run src/renderer/state/__tests__/promptSessions.test.ts tests/unit/promptSessionSchema-crossBoundary.spec.ts
timeout 120 npm run lint:selectors
```

Then confirm the real incident log now verifies clean, using the actual archived transcript
(guard the grep so the no-match path exits 0):

```bash
LOG=/home/bilko/.claude/session-manager/scheduled-plans/runs/2026-08-03T00-31-05-586Z/955-route-epic-create-through-ipc.log
if [ -f "$LOG" ]; then echo "incident log present"; else echo "incident log rotated away — skip this check"; fi
```

If the log still exists, add a temporary node one-liner (or a test fixture derived from it)
that runs the scan over it and prints the verdict; assert it is no longer `transcript_errors`.
Do not leave the temporary script in the tree.

# Acceptance criteria

- [ ] `parseLog` in `src/main/runVerify.cjs` records `parentToolUseId` on both `tool_use` and
      `tool_result` events, defaulting to `null`, and the event-shape doc comment lists it.
- [ ] The `is_error` scan skips any `tool_result` whose `parentToolUseId` is non-null, with the
      incident-citing comment from Step 2 present.
- [ ] The exemption is placed after the `isHarnessToolError` check and before the `is_error`
      branch — main-agent (`parentToolUseId === null`) errors in the final 20% still produce
      `transcript_errors`.
- [ ] Three new tests exist in `src/main/__tests__/runVerify.test.cjs`: subagent-internal
      is_error → not flagged; main-agent is_error → still flagged; `parseLog` populates
      `parentToolUseId` correctly.
- [ ] `src/main/lib/epicMint.cjs:225` and the `tests/unit/promptSessionSchema-crossBoundary.spec.ts`
      header comment no longer describe the renderer's `buildPromptSession` as live, and credit
      PRD 955 / `ba54269` for retiring it.
- [ ] `timeout 300 npm run typecheck` passes.
- [ ] `timeout 300 npx vitest run src/main/__tests__/runVerify.test.cjs` passes, including the
      three new tests.
- [ ] `timeout 300 npx vitest run src/renderer/state/__tests__/promptSessions.test.ts tests/unit/promptSessionSchema-crossBoundary.spec.ts` passes (PRD 955's landed work is untouched and still green).
- [ ] `timeout 120 npm run lint:selectors` passes.
- [ ] No changes to `src/renderer/state/promptSessions.ts` or any Epic-creation call site.
- [ ] Work is committed during the run and the run's last line is `SCHEDULER_VERDICT: PASS`.

# Engineering standards

## Execution discipline (headless runs)

Data-driven from 400+ scheduler runs: long hangs (not bad code) are the dominant real failure, and "exited clean but left a red test" is the top verifier downgrade. These rules run at execution time — they are inlined into every PRD because the headless executor reads nothing else.

- **Bound every command.** Wrap every test/build/dev-server/deploy/poll command in a hard timeout: `timeout 300 <typecheck|unit>`, `timeout 120 <one e2e spec>`, `curl --max-time 15`. Never run a bare `playwright test`/`vite`/`pnpm dev`, a full e2e suite, or an endpoint-polling publish — those are the SIGTERM/4h-watchdog tail.
- **Verify before done.** Run the acceptance test command once before declaring success. If it's red, fix it or `exit 1` with the failure — never end the run on a failing test (that trips the verifier's `transcript_errors` downgrade).
- **Fail loud, fail fast.** On any step failure, print one diagnostic line and `exit 1`; don't swallow with `|| true` or spin in a silent retry. A `rateLimited` exit-1 is the scheduler's benign auto-pause (auto-resumes next window) — not a failure to engineer around.
- **Stay in the AC.** Do not add work past the acceptance checklist ("while we're here" generators/fixtures are the post-AC-overrun incident). Body must be clean UTF-8 — no NUL/control bytes.
- **You ARE the executor — never re-queue or self-schedule.** A headless PRD run must perform its own acceptance criteria directly. Do NOT invoke `/develop` or any queue-authoring skill from inside a run — those are interactive main-loop skills that author a *new* PRD and return, so the run exits 0 having done nothing (no commit, no sentinel → `needs_review` with `no_verdict_sentinel`). Do NOT call `ScheduleWakeup`/set a tracking loop either — the process exits when the run ends and nothing re-invokes it. This applies just as much to spawning your own review agents and waiting on them: do NOT invoke `/code-review`, `/security-review`, `requesting-code-review`, or any other skill/subagent as a background/async step and then end your turn with something like "I'll wait for the review agents to complete" — a headless run has no next turn, so that line is the run's last output, no verdict sentinel prints, and the job parks in `needs_review` even though the actual work already landed. If a PRD's acceptance criteria call for a second review pass, run it **synchronously, inline, before the finish protocol** — call the reviewer and read its result in the same turn, don't fire-and-wait. If the PRD's work looks large, decompose and execute it inline within this run; never delegate it back to the queue. (Incidents: PRD 460 invoked `/develop`, spawned a duplicate PRD 461, and exited 0 with no work. PRD 479 landed its commit correctly but then backgrounded `/code-review --fix` + `/security-review` and called `ScheduleWakeup` to "wait" for them — same class of failure, different entry point.)
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

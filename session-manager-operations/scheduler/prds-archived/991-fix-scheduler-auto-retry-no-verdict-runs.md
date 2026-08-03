---
title: "Fix: land + verify the Epic-digest prompt ordering so a PRD executor implements the PRD instead of answering the Epic"
cwd: /home/bilko/Projects/session-manager
parallelGroup: 991
estimateMinutes: 40
---

# READ THIS FIRST — the failure class this PRD exists to prevent

The run this PRD replaces exited 0 having produced no diff, no test run, and no verdict
sentinel. The canonical rule it violated, quoted VERBATIM from
`plugins/session-manager-dev/skills/develop/standards.md` ("Execution discipline (headless runs)"):

> **You ARE the executor — never re-queue or self-schedule.** A headless PRD run must perform its own acceptance criteria directly. Do NOT invoke `/develop` or any queue-authoring skill from inside a run — those are interactive main-loop skills that author a *new* PRD and return, so the run exits 0 having done nothing (no commit, no sentinel → `needs_review` with `no_verdict_sentinel`).

You are the executor of THIS PRD. This PRD being queued is the task, not evidence that the
task is done. Your deliverable is a **code diff plus a green test run plus a commit**, not
an analysis, not a recommendation, and not a reply to any conversation you find quoted in
this prompt. Do not conclude "this already shipped" and stop — see the Root cause section
below, which tells you exactly what is already present and what is still missing.

# Root cause

Job `991-scheduler-auto-retry-no-verdict-runs` ran 2026-08-03T06:18:31Z, exit 0, 55s,
4 turns. Log:
`/home/bilko/.claude/session-manager/scheduled-plans/runs/2026-08-03T06-18-31-968Z/991-scheduler-auto-retry-no-verdict-runs.log`

What happened:

1. `src/main/scheduler.cjs` (`executeJob`, around the `contextDigestApplied` block, ~line 2271)
   composed the executor prompt as `prompt = digestText + '\n\n' + prompt`. The Epic context
   digest built by `src/main/lib/epicContextDigest.cjs`'s `buildContextDigest` (`DEFAULT_MAX_CHARS`
   4000; the Epic's `goalText` plus up to `TURN_LIMIT` 40 recent conversational turns) was
   **prepended**, so the Epic's conversation was the first thing the model read and the PRD body
   was buried underneath it.
2. The authoring Epic here is `prd-to-epic-communication-this-seems-to-be-broke-dd52dacb`, whose
   digest is a human asking how a PRD checks back in with its Epic. The executor read that as its
   instruction. Its entire output was a prose answer to that question, ending with the explicit
   line: *"I did **not** queue the pasted PRD, since it would duplicate shipped work."*
3. It made 3 `Bash`/`grep` calls, never `Read` `scheduler.cjs` or `standards.md`, produced zero
   `Edit`/`Write` calls, ran no tests, never printed `SCHEDULER_VERDICT:`, and exited 0 →
   classified `no_verdict_sentinel` → parked.
4. Confirming evidence: this run's
   `991-scheduler-auto-retry-no-verdict-runs.meta.json` has `"contextDigestApplied": true`,
   `"exitCode": 0`, `"durationMs": 54551`, `"originSessionId": "4d5ad773-6991-49be-9549-322afea56aa7"`.
5. Not a one-off: PRD 972 (`runs/2026-08-03T03-44-58-361Z/972-*.log`) failed identically —
   `contextDigestApplied: true`, 5 turns, 34s, result text an Epic status recap, no code.

## What has ALREADY been done (verify, do not redo)

A concurrent job landed a partial fix in the working tree roughly four minutes **after** the
991 run started (source mtimes 2026-08-02 23:22–23:23 PDT vs run start 23:18:37 PDT). As of
this PRD's authoring these changes are **uncommitted and unverified**:

- `src/main/lib/epicContextDigest.cjs` — added `composeExecutorPrompt({ prdBody, digestText, maxChars })`
  and a `TASK_RESTATEMENT` constant; exports it. It returns
  `[prdBody, fenceHeader, clippedDigest, fenceFooter, TASK_RESTATEMENT].join('\n\n')` — PRD body
  first, digest fenced as background-only, task restated last.
- `src/main/scheduler.cjs` — imports `composeExecutorPrompt` and replaced the prepend with
  `prompt = composeExecutorPrompt({ prdBody: prompt, digestText });`
- `src/main/__tests__/epicContextDigest.test.cjs` and
  `src/main/__tests__/scheduler-epic-digest.test.cjs` — modified.

**Your first job is to confirm the current on-disk state yourself** (`git status --porcelain`,
`git log --oneline -5`, `git diff`) rather than assuming the above. The changes may since have
been committed by that other job, may be partially present, or may have been reverted. Branch
on what you actually find:

- If the changes are present and uncommitted → verify them (below), fix the residual defect, and commit.
- If already committed → verify them, fix the residual defect, and commit the residual fix.
- If absent → implement `composeExecutorPrompt` and the scheduler wiring yourself as described above, then continue.

Either way, the work below still has to be done and committed by you.

## The residual defect that is definitely NOT yet fixed

At the composition site, `prompt` is **already** `parsed.body + FINISH_PROTOCOL`
(see `src/main/scheduler.cjs` where `prompt = parsed.body + FINISH_PROTOCOL;` is assigned,
~lines 2221 and 2233, before the digest block). So calling
`composeExecutorPrompt({ prdBody: prompt, digestText })` produces this order:

    <PRD body>
    <FINISH PROTOCOL — commit + emit SCHEDULER_VERDICT: PASS as the literal last line>
    --- BEGIN EPIC CONTEXT ... ---
    <4000 chars of Epic conversation>
    --- END EPIC CONTEXT ---
    Your task is the PRD at the top of this prompt. Implement it now.

The finish protocol — the single thing that tells the executor to commit and print the verdict
sentinel — is now buried in the middle of the prompt, with 4000 chars of conversation after it.
That directly undermines the `no_verdict_sentinel` outcome this whole change is meant to prevent.
The correct order is: **PRD body → fenced digest → finish protocol → task restatement**, or
equivalently the finish protocol must remain in the final, most-recent portion of the prompt,
after the digest.

# Fix steps

1. `git status --porcelain && git log --oneline -8 && git diff --stat` — establish actual state.
   Read `src/main/scheduler.cjs` around the `contextDigestApplied` block and both
   `prompt = parsed.body + FINISH_PROTOCOL;` assignments. Read all of
   `src/main/lib/epicContextDigest.cjs`. Read
   `src/main/__tests__/epicContextDigest.test.cjs` and
   `src/main/__tests__/scheduler-epic-digest.test.cjs`.
2. Restructure the composition so the finish protocol is **after** the digest fence and in the
   prompt's tail. Preferred shape: stop concatenating `FINISH_PROTOCOL` into `prompt` before the
   digest block, and instead pass the three pieces to `composeExecutorPrompt` explicitly — e.g.
   `composeExecutorPrompt({ prdBody: parsed.body, digestText, finishProtocol: FINISH_PROTOCOL })`,
   emitting `[prdBody, fence+digest, finishProtocol, TASK_RESTATEMENT]`. Keep the no-digest path
   byte-identical to today's `parsed.body + FINISH_PROTOCOL` where practical, or at minimum keep
   the finish protocol last-but-one there too. Do not change `FINISH_PROTOCOL`'s own text.
3. Keep the digest strictly bounded and never let it displace the PRD body: `composeExecutorPrompt`
   re-caps the digest at `maxChars` (default 4000) and must never truncate `prdBody`. Confirm the
   truncation marker text is present in the fence header when clipping occurs.
4. Keep every existing invariant: digest build failure stays a silent, logged no-op that still
   dispatches the job; `contextDigestApplied` still reflects whether a digest was folded in and is
   still written into the run's meta.json; `validatePromptForSpawn` still runs on the final
   composed prompt. Do not remove the digest feature.
5. Tests, in `src/main/__tests__/epicContextDigest.test.cjs` (already registered in
   `vitest.config.ts` — verify `scheduler-epic-digest.test.cjs` is registered too and register it
   if not):
   - PRD body appears before the digest fence.
   - The fence header is present and states the digest is background-only / not the task.
   - The finish-protocol text appears AFTER the digest fence footer (this is the new regression
     guard — assert on index positions, not just substring presence).
   - The prompt's final line is the task restatement.
   - A digest longer than `maxChars` is clipped and marked truncated; `prdBody` is never truncated.
   - The empty/absent-digest path returns the body plus finish protocol with no fence.
6. Do not use `shell: true` anywhere; pass argv arrays (project rule).
7. Commit with a conventional-commit message, e.g.
   `fix(scheduler): order the executor prompt so the PRD is the task and the finish protocol stays last`.

# Verification commands

Run each with a hard timeout, and run the gates LAST so the run ends green:

    timeout 300 npm run typecheck
    timeout 300 npx vitest run src/main/__tests__/epicContextDigest.test.cjs src/main/__tests__/scheduler-epic-digest.test.cjs
    timeout 300 npm run lint:selectors
    timeout 600 npm run test:unit

Also print the composed prompt's structure once, as evidence, using a bounded node one-liner
that calls `composeExecutorPrompt` with a short fake PRD body and a short fake digest and echoes
the resulting section order — so the ordering claim is demonstrated, not asserted.

# Acceptance criteria

- [ ] Actual on-disk state established via `git status`/`git log`/`git diff` before any edit, and stated in the completion report.
- [ ] The composed executor prompt orders sections: PRD body → fenced Epic-context digest → finish protocol → task restatement. The finish protocol is NOT buried before the digest.
- [ ] The digest fence header explicitly labels the digest as background/prior conversation that is not the task.
- [ ] The digest is capped (default 4000 chars) and clipping is marked; the PRD body is never truncated to make room.
- [ ] No-digest path still produces the PRD body plus the finish protocol, and still dispatches when `buildContextDigest` throws or returns ''.
- [ ] `contextDigestApplied` still written to the run's meta.json with unchanged semantics.
- [ ] Unit tests assert section ORDER by index (body < fence < finish protocol < restatement), the truncation marker, and the empty-digest path. All new tests are in a file registered in `vitest.config.ts`.
- [ ] `timeout 300 npm run typecheck` passes.
- [ ] `timeout 300 npm run lint:selectors` passes.
- [ ] `timeout 600 npm run test:unit` passes.
- [ ] All changes are COMMITTED during this run (an uncommitted working tree is the failure mode that produced this PRD's predecessor state).
- [ ] Final line of the run is the truthful verdict sentinel per the finish protocol.

# Out of scope

- Removing or disabling the Epic context digest feature.
- Any change to `FINISH_PROTOCOL`'s wording.
- The auto-retry / commit-guard / `needs_review` classification machinery (`commitGuardVerdict`, `classifyFailureOutcome`, `TRANSIENT_RETRY_CAP`, `RESCANNABLE_VERDICTS`) — that is the detection side and is separately owned. This PRD is the cause side only.
- Re-authoring or re-queueing the original PRD 991's auto-retry feature.
- Renderer changes of any kind.

## Engineering standards

The section below is quoted verbatim from
`plugins/session-manager-dev/skills/develop/standards.md`. Every rule is mandatory.

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

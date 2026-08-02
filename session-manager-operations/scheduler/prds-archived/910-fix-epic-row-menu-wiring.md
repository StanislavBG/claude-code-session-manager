---
title: "Fix: commit the already-green PRD 910 Epic row-menu diff and emit the finish sentinel"
cwd: /home/bilko/Projects/session-manager
parallelGroup: 910
estimateMinutes: 12
---

# READ THIS FIRST — canonical rule from `standards.md`, quoted verbatim

> **You ARE the executor — never re-queue or self-schedule.** A headless PRD run must perform its own acceptance criteria directly. Do NOT invoke `/develop`, `/propose-epic`, or any queue-authoring skill from inside a run — those are interactive main-loop skills that author a *new* PRD and return, so the run exits 0 having done nothing (no commit, no sentinel -> `needs_review` with `no_verdict_sentinel`). Do NOT call `ScheduleWakeup`/set a tracking loop either — the process exits when the run ends and nothing re-invokes it. This applies just as much to spawning your own review agents and waiting on them: do NOT invoke `/code-review`, `/security-review`, `requesting-code-review`, or any other skill/subagent as a background/async step and then end your turn with something like "I'll wait for the review agents to complete" — a headless run has no next turn, so that line is the run's last output, no verdict sentinel prints, and the job parks in `needs_review` even though the actual work already landed. If a PRD's acceptance criteria call for a second review pass, run it **synchronously, inline, before the finish protocol** — call the reviewer and read its result in the same turn, don't fire-and-wait.

A queued PRD is the task, not evidence of completion. **The deliverable of this run is a landed git commit plus a truthful `SCHEDULER_VERDICT: PASS` as the literal last line.** For THIS PRD specifically: do NOT invoke `security-review`, `code-review`, `requesting-code-review`, `/develop`, `/propose-epic`, `ScheduleWakeup`, or any skill at all. The prior run failed for exactly that reason.

# Root-cause analysis

PRD `910-epic-row-menu-wiring` (run `2026-08-01T21-22-58-462Z`, session `51188a9b-a65d-450d-8064-8d98dc041720`) **did not fail on code**. It succeeded and then failed to finish:

1. It read `EpicQueue.tsx` / `EpicDetail.tsx` / `promptSessions.ts`, then made 11 `Edit` calls implementing the whole feature — RowEditor (title input + goal textarea, Cmd+Enter save / Escape cancel), Duplicate-as-new-Epic, danger Delete with an in-menu confirm step, Reopen for completed Epics, `splitTitleAndGoal` exported from `EpicDetail.tsx` and imported by `EpicQueue.tsx`, plus toast.error guards on the throwing store actions. Net diff: `EpicQueue.tsx +346/-...`, `EpicDetail.tsx ~16 lines`.
2. At 21:29:10 it ran all three AC gates and they were **all green**: `npm run typecheck`, `node scripts/check-unstable-selectors.cjs`, `timeout 120 npx vitest run src/renderer/components/epics/__tests__` (72 tests passing).
3. It then invoked the `security-review` skill as its **final action**. That skill's prompt ends with *"Your final reply must contain the markdown report and nothing else."* — which took over the run's terminal turn.
4. Consequence: the run emitted a security-review markdown report and **exited 0 with no `git commit` and no `SCHEDULER_VERDICT` sentinel**. `910-epic-row-menu-wiring.verdicts.json` recorded `verdict: no_verdict_sentinel`, `downgradeTo: needs_review`. The finished work is still **uncommitted in the working tree**.

Contributing cause: PRD 910's `## Engineering standards` section only *pointed* at `standards.md` (via a stale `~/.npm/_npx/...` cache path) rather than inlining the "Execution discipline (headless runs)" text. The transcript shows the executor never `Read` that file, so the rule quoted at the top of this PRD — which names this exact failure mode — never reached it. This is the PRD-479 failure class recorded in `standards.md`: work lands, finish protocol is skipped because a review skill owns the last turn.

# Concrete fix steps

Work in `/home/bilko/Projects/session-manager`. **Do not re-implement the feature** — it is already in the working tree. Your job is to validate it, fix anything red, and land it.

1. **Inspect the existing uncommitted work.**
   ```bash
   git -C /home/bilko/Projects/session-manager status --short
   git -C /home/bilko/Projects/session-manager diff --stat -- src/renderer/components/epics/
   git -C /home/bilko/Projects/session-manager diff -- src/renderer/components/epics/EpicQueue.tsx src/renderer/components/epics/EpicDetail.tsx
   ```
   Expected: `EpicQueue.tsx` and `EpicDetail.tsx` modified, containing `RowEditor`, `renameEpic`, `duplicateEpic`, `deleteEpic`, `resumeArchived`, and an exported `splitTitleAndGoal`.
   - If those changes are **present**, proceed to step 2.
   - If they are **absent** (someone reverted or committed them since), first check `git log --oneline -5` — if a commit already landed them, skip to step 4 and just verify the gates. Otherwise implement PRD 910's original acceptance criteria yourself, inline, in this run (they are restated in "Feature acceptance criteria" below).

2. **Scope check — commit ONLY the two files that belong to PRD 910.** The working tree may also contain unrelated pre-existing WIP (`src/renderer/components/epics/EpicComposer.tsx`, files under `session-manager-operations/`, `src/renderer/App.tsx`, `src/renderer/state/layout.ts`, etc.). The prior run made **no edits** to any of those — they are not yours. Stage explicitly by path; never `git add -A`, never `git stash`, never `git checkout --` anything you did not author:
   ```bash
   git -C /home/bilko/Projects/session-manager add src/renderer/components/epics/EpicQueue.tsx src/renderer/components/epics/EpicDetail.tsx
   ```

3. **Sanity-review the staged diff yourself, inline, by reading it** — do NOT spawn a review agent or invoke a review skill. Confirm against the feature AC below. Fix anything genuinely broken with `Edit`, then re-stage.

4. **Run the three AC gates, bounded, as the LAST commands before the finish protocol:**
   ```bash
   timeout 300 npm run typecheck 2>&1 | tail -40
   timeout 120 node scripts/check-unstable-selectors.cjs 2>&1 | tail -20
   timeout 180 npx vitest run src/renderer/components/epics/__tests__ 2>&1 | tail -30
   ```
   All three must be green. If any is red, fix it and re-run the same command with the same description. Never emit `PASS` on a red gate.

5. **Commit**, then emit the sentinel as the literal last line of the run:
   ```bash
   git -C /home/bilko/Projects/session-manager commit -m "feat(epics): wire rename/edit-goal RowEditor, duplicate, delete confirm, reopen into Epic queue row menu"
   ```
   Then print `SCHEDULER_VERDICT: PASS`.

# Verification commands

```bash
timeout 300 npm run typecheck
timeout 120 node scripts/check-unstable-selectors.cjs
timeout 180 npx vitest run src/renderer/components/epics/__tests__
git -C /home/bilko/Projects/session-manager log --oneline -1
git -C /home/bilko/Projects/session-manager status --short -- src/renderer/components/epics/EpicQueue.tsx src/renderer/components/epics/EpicDetail.tsx   # must print nothing
```

# Acceptance criteria

- [ ] `git log -1` shows a NEW commit authored during this run containing `src/renderer/components/epics/EpicQueue.tsx` and `src/renderer/components/epics/EpicDetail.tsx`.
- [ ] `git status --short` for those two paths is empty after the commit (nothing left uncommitted).
- [ ] No unrelated file (`EpicComposer.tsx`, `App.tsx`, `state/layout.ts`, anything under `session-manager-operations/`) is included in that commit, and no pre-existing uncommitted WIP was stashed, reverted, or dropped.
- [ ] `timeout 300 npm run typecheck` exits 0.
- [ ] `timeout 120 node scripts/check-unstable-selectors.cjs` exits 0.
- [ ] `timeout 180 npx vitest run src/renderer/components/epics/__tests__` exits 0 with the existing 72 tests passing (no new tests required — that is `epic-row-menu-test-coverage`'s job).
- [ ] The run's literal last output line is `SCHEDULER_VERDICT: PASS`.
- [ ] No `Skill` tool invocation and no `ScheduleWakeup` call occurred anywhere in this run.

## Feature acceptance criteria (restated from PRD 910 — verify the existing diff satisfies these; only implement if the diff is missing)

- [ ] "Rename title" / "Edit goal / first prompt" replaces the row **in place** (not a modal) with a RowEditor: title text input + goal textarea prefilled via `EpicDetail.tsx`'s `splitTitleAndGoal` on the epic's `goalText`; Save disabled until title is non-empty AND something changed; Cancel button; Cmd+Enter saves, Escape cancels; Save calls `renameEpic(id, title, goal)`.
- [ ] "Duplicate as new Epic" calls `duplicateEpic(id)` and selects the resulting new Epic via the existing `onSelect` callback.
- [ ] "Delete Epic" uses the existing `danger` MenuItem flag and requires a confirm step (second click / "Click again to delete…" or an inline popover) before calling `deleteEpic` — **no native `window.confirm`**. A throw from `deleteEpic` (guard: live scheduler job / chat run / attached terminal) surfaces via the existing `toast.error(...)` pattern, not silently.
- [ ] "Reopen" appears only for a completed/archived Epic and calls the existing `resumeArchived(epic.id)` store action.
- [ ] All items live in the SAME `useRowMenuItems()` / `RowMenuButton` flow already in `EpicQueue.tsx` — no second parallel menu component.
- [ ] Nothing beyond the above was added (no "while we're here" extras — see Stay in the AC below).

# Out of scope

- New store mutations in `src/renderer/state/promptSessions.ts` — already landed in commit `244f06f`.
- New automated test coverage for the five menu actions — that is `epic-row-menu-test-coverage`'s PRD.
- Composer quote-reply.
- Any version bump, `npm publish`, or `git push`.

# Engineering standards

## Execution discipline (headless runs)

Data-driven from 400+ scheduler runs: long hangs (not bad code) are the dominant real failure, and "exited clean but left a red test" is the top verifier downgrade. These rules run at execution time — they are inlined into every PRD because the headless executor reads nothing else.

- **Bound every command.** Wrap every test/build/dev-server/deploy/poll command in a hard timeout: `timeout 300 <typecheck|unit>`, `timeout 120 <one e2e spec>`, `curl --max-time 15`. Never run a bare `playwright test`/`vite`/`pnpm dev`, a full e2e suite, or an endpoint-polling publish — those are the SIGTERM/4h-watchdog tail.
- **Verify before done.** Run the acceptance test command once before declaring success. If it's red, fix it or `exit 1` with the failure — never end the run on a failing test (that trips the verifier's `transcript_errors` downgrade).
- **Fail loud, fail fast.** On any step failure, print one diagnostic line and `exit 1`; don't swallow with `|| true` or spin in a silent retry. A `rateLimited` exit-1 is the scheduler's benign auto-pause (auto-resumes next window) — not a failure to engineer around.
- **Stay in the AC.** Do not add work past the acceptance checklist ("while we're here" generators/fixtures are the post-AC-overrun incident). Body must be clean UTF-8 — no NUL/control bytes.
- **You ARE the executor — never re-queue or self-schedule.** A headless PRD run must perform its own acceptance criteria directly. Do NOT invoke `/develop`, `/propose-epic`, or any queue-authoring skill from inside a run — those are interactive main-loop skills that author a *new* PRD and return, so the run exits 0 having done nothing (no commit, no sentinel → `needs_review` with `no_verdict_sentinel`). Do NOT call `ScheduleWakeup`/set a tracking loop either — the process exits when the run ends and nothing re-invokes it. This applies just as much to spawning your own review agents and waiting on them: do NOT invoke `/code-review`, `/security-review`, `requesting-code-review`, or any other skill/subagent as a background/async step and then end your turn with something like "I'll wait for the review agents to complete" — a headless run has no next turn, so that line is the run's last output, no verdict sentinel prints, and the job parks in `needs_review` even though the actual work already landed. If a PRD's acceptance criteria call for a second review pass, run it **synchronously, inline, before the finish protocol** — call the reviewer and read its result in the same turn, don't fire-and-wait. If the PRD's work looks large, decompose and execute it inline within this run; never delegate it back to the queue. (Incidents: PRD 460 invoked `/develop`, spawned a duplicate PRD 461, and exited 0 with no work. PRD 479 landed its commit correctly but then backgrounded `/code-review --fix` + `/security-review` and called `ScheduleWakeup` to "wait" for them — same class of failure, different entry point.)
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

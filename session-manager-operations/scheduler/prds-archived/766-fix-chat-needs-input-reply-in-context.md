---
title: "Fix: implement needs-input ticket status + reply-in-context affordance (PRD 766 self-delegated instead of executing)"
cwd: /home/bilko/Projects/session-manager
parallelGroup: 766
estimateMinutes: 55
---

# 🚨 READ THIS FIRST — you ARE the executor

The canonical rule from this repo's engineering standards, quoted verbatim:

> **You ARE the executor — never re-queue or self-schedule.** A headless PRD run must perform its own acceptance criteria directly. Do NOT invoke `/develop`, `/process-feedback`, or any queue-authoring skill from inside a run — those are interactive main-loop skills that author a *new* PRD and return, so the run exits 0 having done nothing (no commit, no sentinel → `needs_review` with `no_verdict_sentinel`). Do NOT call `ScheduleWakeup`/set a tracking loop either — the process exits when the run ends and nothing re-invokes it.

**A queued PRD is the task, not evidence of completion.** If you search the scheduler
queue and find a PRD that looks like this one, that is *you* — it is running because
the work has NOT been done. Do not read `queue.json` to decide whether to work. Do not
call the `Skill` tool with `session-manager-dev:develop` or
`session-manager-dev:process-feedback`. Do not call `ScheduleWakeup`.

**The deliverable of this run is a code diff, committed, with green tests.** Nothing else
counts.

# Root-cause analysis

The prior run of PRD `766-chat-needs-input-reply-in-context`
(log: `~/.claude/session-manager/scheduled-plans/runs/2026-07-29T17-14-54-936Z/766-chat-needs-input-reply-in-context.log`)
failed as a textbook self-delegation:

1. It invoked the `Skill` tool with `session-manager-dev:develop` — an interactive,
   queue-authoring skill that is never valid inside a headless run.
2. Following that skill's "don't duplicate an existing PRD" logic, it grepped
   `~/.claude/session-manager/scheduled-plans/queue.json`, found
   `766-chat-needs-input-reply-in-context` in status `running`, and announced
   *"This is already queued verbatim as PRD 766. No need to create a duplicate."* —
   not recognizing that the `running` job it found **was itself**.
3. It then called `ScheduleWakeup` to "check back in 30 minutes and verify against
   acceptance criteria." A headless `claude -p` process has no next turn; nothing ever
   re-invoked it.
4. It exited 0 after 35 seconds with **zero file edits, no commit, no test run, and no
   `SCHEDULER_VERDICT` sentinel**.

There is no bug in the target source. The entire original acceptance criteria set is
still unimplemented. Your job is to implement it, inline, in this run.

# Goal (restated — this is the actual work)

A headless chat run can stop mid-turn via the `<<<SM_NEEDS_INPUT>>>` sentinel
(`src/main/chatRunner.cjs`), broadcast as `chat:run:needs-input` with
`{ tabId, sessionId, questions, answerBody, raw }`. Today that renders only as an inline
amber "❓ Needs your answer" card in the transcript. Nothing distinguishes a ticket that is
actually stalled waiting on the user from one that merely finished: `PromptTicket.status`
in `src/renderer/state/chat.ts` has no needs-input value, so the ticket is finalized as
`'done'` and the Prompt Queue panel shows it as completed. Users then type their answer as
what feels like a fresh unrelated prompt.

Mechanically the reply already resumes the correct session (the composer's `send()` always
resumes that tab's persistent `sessionId`), so this is a **UI/status-clarity gap, not a
routing bug**. Add a real `needs-input` ticket status plus visual treatment in the Prompt
Queue panel and the composer.

# Concrete fix steps

Line numbers below are from prior research and **may have drifted** — locate by symbol,
not by line number. Read each file before editing.

1. **`src/renderer/state/chat.ts`**
   - Add `'needs-input'` to the `PromptTicket['status']` union (currently
     `'queued' | 'running' | 'dispatched-to-prd' | 'done' | 'failed'`, in the
     `PromptTicket` interface around line 48–59).
   - In the `window.api.chat.onNeedsInput(...)` subscription (~line 392–421, which today
     pushes a `role: 'question'` turn and finalizes the run through the normal completion
     path): set the corresponding ticket for that run to `'needs-input'` instead of
     `'done'`.
   - In `send()` (~line 186+): the next successful send for that `tabId` must clear the
     needs-input state — the ticket transitions back to `'done'`/`'running'` per the
     existing resume behavior. Do **not** add a new `respondTo` field or an
     answer-specific IPC path; the existing `sessionId`-based resume is correct.

2. **`src/renderer/lib/ticketDisplay.ts`**
   - Add a distinct branch in `ticketDisplayStatus` for `'needs-input'` — amber tone,
     label `Needs your answer`. Do not let it fall through to an existing status.

3. **`src/renderer/components/TerminalChat.tsx`**
   - `QueueTicketPanel` (definition ~line 340–430, rendered ~line 790–801): render a
     `needs-input` ticket distinctly from `queued`/`running`/`done`, reusing the panel's
     existing pill/badge styling pattern in amber to match the inline question card.
   - Clicking a `needs-input` ticket scrolls the transcript to, and briefly highlights,
     the corresponding `role: 'question'` turn (the amber "❓ Needs your answer" card,
     `Turn` renderer ~line 459–475) **and** focuses the composer textarea.
   - Composer placeholder (~line 810–816): while the tab has an outstanding
     `needs-input` ticket, use an explicit placeholder such as
     `Reply to answer the pending question…` instead of the generic
     `Type a command…` / `Running… send to queue a follow-up prompt`.
   - When a tab has multiple queued tickets and one is `needs-input`, pin/prioritize the
     needs-input one near the top of the panel so it cannot scroll out of view behind
     newer queued prompts.

4. **Tests**
   - Extend `src/renderer/components/__tests__/QueueTicketPanel.test.tsx` (follow its
     existing pattern): a ticket with status `needs-input` renders the distinct treatment,
     and clicking it fires the scroll/focus callback.
   - Extend chat store coverage (look under `src/renderer/state/__tests__/` for the
     existing `chat*` spec): `onNeedsInput` sets the ticket to `needs-input` rather than
     `done`, and a subsequent `send()` on that tab clears it.

# Verification commands

Run these bounded, in this order, with the green gate LAST:

```
timeout 300 npm run typecheck
timeout 600 npx vitest run
```

Note: `SM_CHAT_CONCURRENCY` may be exported in the shell profile and can make
`chatRunner.spec` red locally for unrelated reasons — if that spec fails, `unset
SM_CHAT_CONCURRENCY` and re-run before treating it as your regression.

# Acceptance criteria

- [ ] `'needs-input'` is a member of the `PromptTicket['status']` union in `src/renderer/state/chat.ts`.
- [ ] `onNeedsInput` sets the run's ticket to `'needs-input'`, not `'done'`.
- [ ] The next successful `send()` for that `tabId` clears the needs-input state back to normal (`running`/`done`) via the existing resume path — no new IPC channel, no `respondTo` field.
- [ ] `ticketDisplayStatus` in `src/renderer/lib/ticketDisplay.ts` has a dedicated amber `'needs-input'` branch labelled "Needs your answer".
- [ ] `QueueTicketPanel` visually marks a `needs-input` ticket distinctly (amber pill/badge, matching the inline question card).
- [ ] Clicking a `needs-input` ticket scrolls to + briefly highlights the question turn AND focuses the composer textarea.
- [ ] The composer placeholder changes while a needs-input ticket is outstanding on that tab.
- [ ] A `needs-input` ticket is pinned/prioritized above ordinary queued tickets in the panel.
- [ ] `QueueTicketPanel.test.tsx` covers the distinct rendering + the click callback.
- [ ] A chat-store test asserts `onNeedsInput` → `needs-input` and that a following `send()` clears it.
- [ ] `timeout 300 npm run typecheck` passes.
- [ ] `timeout 600 npx vitest run` passes.
- [ ] Work is **committed** and the run ends with the literal `SCHEDULER_VERDICT: PASS` line.

# Out of scope

- Building a real modal/dialog for needs-input — keep it inline in the transcript + Prompt Queue panel, just with correct status and a scroll/focus affordance.
- Any change to `chatRunner.cjs`'s sentinel protocol or payload shape.
- Multi-question branching UI (answering questions one at a time, structured per-question forms) — the existing free-text reply-via-composer mechanism is unchanged.
- Any new answer-targeting IPC call or `respondTo` field.

## Engineering standards

Data-driven from 400+ scheduler runs: long hangs (not bad code) are the dominant real failure, and "exited clean but left a red test" is the top verifier downgrade. These rules run at execution time — they are inlined into every PRD because the headless executor reads nothing else.

- **Bound every command.** Wrap every test/build/dev-server/deploy/poll command in a hard timeout: `timeout 300 <typecheck|unit>`, `timeout 120 <one e2e spec>`, `curl --max-time 15`. Never run a bare `playwright test`/`vite`/`pnpm dev`, a full e2e suite, or an endpoint-polling publish — those are the SIGTERM/4h-watchdog tail.
- **Verify before done.** Run the acceptance test command once before declaring success. If it's red, fix it or `exit 1` with the failure — never end the run on a failing test (that trips the verifier's `transcript_errors` downgrade).
- **Fail loud, fail fast.** On any step failure, print one diagnostic line and `exit 1`; don't swallow with `|| true` or spin in a silent retry. A `rateLimited` exit-1 is the scheduler's benign auto-pause (auto-resumes next window) — not a failure to engineer around.
- **Stay in the AC.** Do not add work past the acceptance checklist ("while we're here" generators/fixtures are the post-AC-overrun incident). Body must be clean UTF-8 — no NUL/control bytes.
- **You ARE the executor — never re-queue or self-schedule.** A headless PRD run must perform its own acceptance criteria directly. Do NOT invoke `/develop`, `/process-feedback`, or any queue-authoring skill from inside a run — those are interactive main-loop skills that author a *new* PRD and return, so the run exits 0 having done nothing (no commit, no sentinel → `needs_review` with `no_verdict_sentinel`). Do NOT call `ScheduleWakeup`/set a tracking loop either — the process exits when the run ends and nothing re-invokes it. This applies just as much to spawning your own review agents and waiting on them: do NOT invoke `/code-review`, `/security-review`, `requesting-code-review`, or any other skill/subagent as a background/async step and then end your turn with something like "I'll wait for the review agents to complete" — a headless run has no next turn, so that line is the run's last output, no verdict sentinel prints, and the job parks in `needs_review` even though the actual work already landed. If a PRD's acceptance criteria call for a second review pass, run it **synchronously, inline, before the finish protocol** — call the reviewer and read its result in the same turn, don't fire-and-wait. If the PRD's work looks large, decompose and execute it inline within this run; never delegate it back to the queue. (Incidents: PRD 460 invoked `/develop`, spawned a duplicate PRD 461, and exited 0 with no work. PRD 479 landed its commit correctly but then backgrounded `/code-review --fix` + `/security-review` and called `ScheduleWakeup` to "wait" for them — same class of failure, different entry point.)
- **A shared-repo `cwd` can be occupied by a concurrent job — check before you touch shared state.** When a PRD's `cwd` is a repo other headless runs may also target (a shared team repo like sigma, not a private single-purpose project), a `git checkout`/`gh pr checkout` can land you in another job's live worktree with its own uncommitted WIP. Before running `git stash`, `git reset`, or any command that discards or hides working-tree state, check `git stash list` and `git status` first, and if you must set aside pre-existing uncommitted changes that aren't yours, **stash with a descriptive message** (`git stash push -m "pre-existing WIP found by PRD <NN>, not mine"`) and **restore it before your run ends** (or, if you can't safely restore because your own commit depends on that worktree state, leave it stashed with the message and say so explicitly in your finish output — never let the run end silently dropping someone else's stash). Never `git stash drop`/`git clean -fd` on state you didn't create. (Incident: PRD 477 stashed a concurrent job's rAF-throttle-revert WIP to get its own checkout, finished, and exited without restoring it — orphaning the other job's uncommitted work in `stash@{0}` with no record of whose it was.)
- **`gh pr edit --body` can fail on repos with legacy GitHub Projects (classic) boards** — the underlying GraphQL query fetches `repository.pullRequest.projectCards`, a field GitHub is sunsetting, and errors with `GraphQL: Projects (classic) is being deprecated ... (repository.pullRequest.projectCards)` even though the edit itself would otherwise succeed. This is a known `gh` CLI quirk, not a defect in your work. Prefer `gh api -X PATCH repos/<owner>/<repo>/pulls/<n> -f body="$(cat body.md)"` for updating a PR description headlessly — it doesn't touch the deprecated field. If you do use `gh pr edit` and it fails this way, don't leave the bare GraphQL error as the last thing in that step (it reads as an unrecovered error in the final-20%-of-transcript verifier heuristic): immediately retry with the `gh api` form and print one line noting the known-bug fallback, so the recovery is adjacent to the error.
- **Negative-assertion checks must exit 0 when clean.** A check that verifies the *absence* of something (a `grep` that should find nothing, "no leftover X", `diff` expecting no change) must return exit 0 on the clean case. A bare `grep` exits **1 on no-match** — so the *success* path surfaces as `is_error=true` and the verifier downgrades a perfect run to `needs_review`. Always invert: `if <detector>; then echo "HALT: <what was found>"; exit 1; fi; echo clean`. Never let the no-match/empty path carry the non-zero exit.
- **Recover or annotate every error — don't strand a Traceback in the transcript.** The verifier downgrades an otherwise-perfect run to `needs_review` when a `Traceback`/`Error` appears with *no visible recovery within ~10 lines* (the `transcript_errors` heuristic — the single most common false-positive on green deliverables). Two executor habits cause it: (1) **throwaway probes that error** — an inline `python -c` with a quoting/f-string slip, a wrong kwarg, a bad path. When a probe errors, immediately re-run the corrected version *or* print one line `# expected/handled: <why>` right after, so recovery is adjacent. Don't move on leaving a bare error as the last thing in that step. Prefer a small temp `.py` file over a fragile multi-quote `python -c` one-liner (inline f-string errors are the top source of stranded tracebacks). (2) See the timeout rule below.
- **An *expected* bounded-timeout (exit 124) must be annotated, not bare.** `timeout`-capping a genuinely long task you expect to hit the cap (a full-universe ingest, a long scan) is correct — but a bare `Exit code 124` reads as a failure to the verifier. Wrap it so the cap is a success-with-note: `timeout 120 <cmd> || { rc=$?; [ $rc -eq 124 ] && echo "hit time cap — idempotent/partial, rows persist incrementally; OK" || { echo "HALT: <cmd> failed rc=$rc"; exit 1; }; }`. (Distinguish 124 = expected cap from a real non-zero.) For work that legitimately needs longer than a safe cap, run it in the background and poll a bounded number of times rather than capping the foreground command.
- **Polling remote CI/job status: never `sleep N && <cmd>`, and annotate the pending exit code.** The harness hard-blocks a `sleep` chained to another command (`Blocked: sleep 90 followed by: gh pr checks ...`) and that block lands in the transcript as a bare `is_error=true` — usually in the last 20% of the run, right where the verifier weighs errors most. To wait for a remote run, use the tool's own blocking watcher under a hard cap: `timeout 600 gh run watch <run-id> --repo <owner>/<repo> --exit-status`. Also note `gh pr checks` is a **negative-assertion-shaped command**: it exits `8` while checks are pending and `1` when a check failed or none are reported — so the ordinary "still running" path is non-zero. Wrap it so the expected cases print a clean token rather than a bare error: `if out=$(timeout 60 gh pr checks <n> --repo <r> 2>&1); then echo "CI GREEN"; else rc=$?; echo "gh pr checks rc=$rc (8=pending, 1=fail/none) — expected/handled"; fi`. (Incident: PRD 745 fixed PR #188's Lint + Docs-integrity failures, pushed, and CI went fully green — but its `sleep 20 && gh pr checks` (exit 8) and `sleep 90 && gh pr checks` (harness-blocked) sat unannotated at the very end of the transcript and the run was flagged despite a truthful PASS and a landed commit.)
- **Finish so the verifier auto-clears you.** The scheduler appends a finish protocol that requires you to COMMIT your work and emit `SCHEDULER_VERDICT: PASS` (or `FAIL <reason>` + `exit 1`) as the literal last line. Honor it exactly: a *truthful* PASS plus a commit that landed during the run is what lets the verifier override incidental transcript noise (a grep hit containing "Error", a TDD red-phase run, a debug Traceback) instead of parking the job in `needs_review` for a human. A job that exits 0 with **uncommitted** changes, or with no PASS sentinel, is the #1 cause of needless `needs_review`. Never print PASS on a red gate — a lying PASS turns the verifier into a silent-failure shipper.
- **Don't leak expected-error text into tool output.** The verifier pattern-matches transcript content for `Traceback`/`FAIL`/`Error:`. When a step is *expected* to error (a TDD red-phase test, an availability/existence probe, a "should raise" assertion), don't let the raw exception land verbatim — capture it and surface a clean token instead: `if python -c '…' 2>/dev/null; then echo PROBE_OK; else echo PROBE_ABSENT; fi`, or pipe the noisy run through a matcher that prints only `RED (expected)` / `GREEN`. When you retry a transient failure, re-run the **same command with the same description** — the verifier's self-recovery detector pairs a failed call with a later identical-description call that succeeds and clears it.
- **End green: run the acceptance/test gate LAST, and let nothing error after it.** The post-run verifier scans the transcript and downgrades to `needs_review` on error markers — and weighs the *final* portion of the run most heavily (a tool error in the last ~20% trips it even if everything actually passed). So order the run so the last command is the green AC gate: do any intentionally-failing step (e.g. a TDD red test, an expected-nonzero probe) **early**, never after the gate. If you must demonstrate a failure late, capture it so it doesn't surface as a raw `is_error`/`Traceback` (`… 2>&1 | tail` inside a conditional, or assert on the captured text) rather than letting it hit the transcript bare.
- **The verdict sentinel is your authoritative "I passed" signal — emit it truthfully.** The scheduler appends a FINISH PROTOCOL that ends by printing `SCHEDULER_VERDICT: PASS` once the AC gate is green and the commit has landed (or `SCHEDULER_VERDICT: FAIL <reason>` + `exit 1` otherwise). The verifier treats `PASS` + a commit that landed during the run as **authoritative** and overrides incidental transcript markers — so a *deliberately reproduced* red test (systematic-debugging) or a grep result containing the word "Error" will **not** false-trip `needs_review`, as long as the run genuinely ends green and committed. Never print `PASS` when the gate is red — that's the one thing that turns a safety net into a silent-failure machine.

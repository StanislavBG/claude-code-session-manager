---
title: "Fix: lock in the already-landed external-send Epic resolution with a regression test and close out PRD 897"
cwd: /home/bilko/Projects/session-manager
parallelGroup: 897
estimateMinutes: 20
---

# Root-cause analysis (read this first — it changes what your job is)

The previous run of PRD `897-external-send-epic-targets-and-dead-channels` did **not** fail
because of bad code. It failed because it produced **no commit**.

What actually happened:

- The whole acceptance set of PRD 897 had already landed a day earlier, in commit
  **`00b57bd`** — `fix(chat,scheduler): resolve external-send targets against Epics, not just
  SessionTabs` (2026-07-31 22:03 PDT). That commit is an ancestor of `HEAD`.
- The 2026-08-01T16:01 run correctly inspected the tree, found every AC already satisfied,
  wrote an accurate summary, and printed a truthful `SCHEDULER_VERDICT: PASS`, exiting 0.
- But the scheduler's verifier treats **exit 0 with no commit landed during the run** as
  unverifiable. The job is now parked at `status: "needs_review"` in
  `session-manager-operations/scheduler/state/queue.json` (`exitCode: 0`, `verdict: null`).
- Secondary contributors: the original PRD file still sits un-archived at
  `session-manager-operations/scheduler/epics/scope-scheduler-left-nav-dot-and-windowstrip-sta-b6ef91a6/prds/897-external-send-epic-targets-and-dead-channels.md`,
  so it stays re-dispatchable; and its acceptance-criteria block is double-nested
  (`- [ ] - [ ]`) from the authoring generator, which makes it hard to read.

State verified in the tree at the time this fix-plan was written (re-verify, do not trust):

- `src/renderer/state/chat.ts` ~:877-900 — `onExternalSend` resolves an open `SessionTab`
  first, then falls back to `usePromptSessions.getState().sessions[tabId]`, refuses an Epic
  with `status === 'completed'` (logging that its `claudeSessionId` is dead), and otherwise
  sends with the Epic's `claudeSessionId` + `cwd`. The final no-match log names both lookups.
- `src/main/scheduler.cjs` — `notifyOriginatingTab` implements the
  `sourcePromptId` → `sourceTabId` → `sourcePromptId` fallback chain and routes into the
  PromptSession event chain.
- `chat:probe-context` / `chat:context-usage`: **zero** references anywhere under `src/`
  (handler, broadcast, preload and zod schema were all removed) — the "dead channel" AC was
  resolved by deletion, not half-wiring.
- No stale `PromptSessionConversation.tsx` references remain in any `.ts`/`.tsx` source or in
  `CLAUDE.md` (only in archived PRD markdown, which is historical record and must NOT be edited).
- Tests present: `src/renderer/state/__tests__/chat.test.ts` (external-send: resolves to Epic,
  resolves to tab, refuses completed Epic, no-match warning naming both lookups; plus the
  Terminal-attached mutual-exclusivity guard) and
  `src/main/__tests__/scheduler-notify-originating-tab.test.cjs` (12 cases).

**So your job is NOT to re-implement PRD 897.** Your job is to (a) independently re-verify the
above, (b) add the one regression artifact that is genuinely missing, and (c) end the run with
a real commit and a truthful PASS so the job can clear.

Do not "fix" anything that is already correct. Do not revert or rewrite `00b57bd`.

# Fix steps

## 1. Re-verify the landed state (do this first, it is cheap)

Run each of these and read the output. If any one of them contradicts the RCA above, the tree
has drifted — in that case, implement the missing piece for real, then continue.

```bash
cd /home/bilko/Projects/session-manager
git merge-base --is-ancestor 00b57bd HEAD && echo "00b57bd is in HEAD"
sed -n '870,905p' src/renderer/state/chat.ts
grep -n "notifyOriginatingTab" src/main/scheduler.cjs | head
# Negative assertion — MUST print "clean" and exit 0 (see the negative-assertion rule below):
if grep -rn "probe-context\|probeContext\|context-usage\|contextUsage" src/; then
  echo "HALT: dead chat context-probe channel still referenced in src/"; exit 1
fi; echo "clean: no probe-context/context-usage refs"
if grep -rn "PromptSessionConversation" --include='*.ts' --include='*.tsx' src/ CLAUDE.md; then
  echo "HALT: stale PromptSessionConversation reference in source"; exit 1
fi; echo "clean: no stale PromptSessionConversation refs in source"
```

Note: `session-manager-operations/scheduler/prds-archived/**` and `.../prds/**` markdown DO
mention `PromptSessionConversation`. Those are archived historical PRDs — leave them alone; the
grep above is deliberately scoped to `src/` and `CLAUDE.md` only.

## 2. Add the missing regression guard (this is the real deliverable)

The dead-channel removal is currently protected by nothing — a future edit could reintroduce
`chat:probe-context` / `chat:context-usage` as a half-wired channel and no test would notice.
Add a source-level regression test that locks it.

Create `src/main/__tests__/chat-dead-channels.test.cjs` (vitest picks up `src/main/**/__tests__`
in this repo — confirm by looking at how `src/main/__tests__/scheduler-notify-originating-tab.test.cjs`
is written and imported, and mirror its style exactly: same `test()` import, same module system,
no new dependencies).

The test must:

- Walk `src/main/`, `src/preload/` and `src/renderer/` for the literal strings
  `chat:probe-context` and `chat:context-usage` (read files with `fs`, skip `node_modules`,
  skip the test file itself), and assert zero hits — with a failure message that explains the
  channel was deliberately removed and must be wired end-to-end or not at all.
- Keep it O(files) with a plain recursive directory walk; no globbing dependency.

Also, if and only if `src/renderer/state/__tests__/chat.test.ts` lacks it, add one case there
asserting that an external send targeting an Epic dispatches with **that Epic's**
`claudeSessionId` and `cwd` (not the tab's) — check first; per the RCA this is likely already
covered by the existing `resolves the target from usePromptSessions…` case, in which case add
nothing and say so.

## 3. Tidy the stale PRD 897 source file

Leave `session-manager-operations/scheduler/state/queue.json` **untouched** — it is scheduler-owned
runtime state and the app is the single writer; editing it by hand corrupts the source of truth.

Do NOT move or delete the original PRD file either. Instead, append one short line at the very
bottom of
`session-manager-operations/scheduler/epics/scope-scheduler-left-nav-dot-and-windowstrip-sta-b6ef91a6/prds/897-external-send-epic-targets-and-dead-channels.md`:

```
> Superseded: implemented in commit 00b57bd (2026-07-31). Closed out by PRD
> 897-fix-external-send-epic-targets-and-dead-channels, which added the dead-channel
> regression guard. Do not re-dispatch.
```

That is a one-line documentation edit; do not restructure the file or fix its `- [ ] - [ ]`
nesting (churn with no value).

## 4. Verification commands

Run these, in this order, and let the green gate be LAST:

```bash
cd /home/bilko/Projects/session-manager
timeout 300 npm run typecheck
timeout 120 npx vitest run src/main/__tests__/chat-dead-channels.test.cjs
timeout 300 npm run lint:selectors
timeout 600 npm run test:unit
```

All four must be green. If `npm run test:unit` is red on a file you did not touch, check
whether `SM_CHAT_CONCURRENCY` is set in the environment (a known local-only source of red in
`chatRunner.spec`) — `unset SM_CHAT_CONCURRENCY` and re-run the same command before concluding
anything.

## 5. Commit

```bash
git add src/main/__tests__/chat-dead-channels.test.cjs \
        src/renderer/state/__tests__/chat.test.ts \
        session-manager-operations/scheduler/epics/scope-scheduler-left-nav-dot-and-windowstrip-sta-b6ef91a6/prds/897-external-send-epic-targets-and-dead-channels.md
git commit -m "test(chat): lock the removed chat context-probe channels with a source regression guard"
```

Stage **only** the files you actually changed. The working tree contains unrelated concurrent
work (PRDs 894–896, `sessionSlots.cjs`, `webRemote.cjs`, `Home.tsx`, `SessionManagerConfig.tsx`,
untracked transcripts and epic dirs) — do not `git add -A`, do not `git stash`, do not
`git clean`, do not touch anyone else's changes.

# Acceptance criteria

- [ ] `00b57bd` confirmed as an ancestor of `HEAD`, and the external-send Epic-resolution logic
      in `src/renderer/state/chat.ts` and the `notifyOriginatingTab` chain in
      `src/main/scheduler.cjs` are confirmed present and correct (or repaired if drifted).
- [ ] A new test file `src/main/__tests__/chat-dead-channels.test.cjs` exists and fails if
      `chat:probe-context` or `chat:context-usage` reappears anywhere under `src/`.
- [ ] `src/renderer/state/__tests__/chat.test.ts` covers external send resolving to an Epic
      with that Epic's `claudeSessionId`/`cwd` (either pre-existing — state so explicitly — or
      newly added).
- [ ] The original PRD 897 file carries the one-line "Superseded / do not re-dispatch" note.
- [ ] `session-manager-operations/scheduler/state/queue.json` is NOT modified by this run.
- [ ] No archived PRD markdown under `prds-archived/` is modified.
- [ ] `timeout 300 npm run typecheck` passes.
- [ ] `timeout 300 npm run lint:selectors` passes.
- [ ] `timeout 600 npm run test:unit` passes, and is the LAST command before the finish protocol.
- [ ] A commit containing only this run's changes has landed, followed by a truthful
      `SCHEDULER_VERDICT: PASS`.

# Out of scope

- Re-implementing or altering the external-send resolution logic that already landed in `00b57bd`.
- Reviving `chat:probe-context` / `chat:context-usage` as a wired channel.
- Editing `queue.json`, archiving/moving PRD files, or otherwise doing the scheduler's
  bookkeeping by hand.
- Any of the unrelated in-flight work in the dirty working tree (894–896, sessionSlots,
  webRemote, Home.tsx, SessionManagerConfig.tsx).
- Fixing the `- [ ] - [ ]` AC nesting in the old PRD file.

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

## Note on the specific failure this PRD repairs

The prior run's exact failure mode is the **"Finish so the verifier auto-clears you"** rule
above: it exited 0 with a truthful PASS but **no commit**, so there was nothing for the verifier
to treat as authoritative and the job parked in `needs_review`. A PRD whose work turns out to be
already done is not "nothing to do" — the deliverable is still a landed diff (here: the
regression guard that pins the behavior so it can't silently regress) plus the commit and the
sentinel. If, contrary to this fix-plan, you find there is genuinely no artifact to add, do NOT
exit 0 empty: emit `SCHEDULER_VERDICT: FAIL nothing to commit — work already landed in 00b57bd`
and `exit 1`, so a human sees it rather than the queue silently re-dispatching.

---
title: "Fix: give PRD 874 a committable artifact — ProjectHome null-cwd render test + face-coverage invariant"
cwd: /home/bilko/Projects/session-manager
parallelGroup: 874
estimateMinutes: 25
---
# Root-cause analysis (read this first)

The original PRD `874-nav-face-project-home` did **not** fail on code. It ran clean, verified
everything it was asked to verify, ran `npm run typecheck` and `npx vitest run
navGroupsHome.test.ts` (8/8 green), and truthfully printed `SCHEDULER_VERDICT: PASS`. Exit code 0.

It was still parked. The scheduler recorded:

```
status: needs_review
exitCode: 0
verifierVerdict: pass_no_commit
error: "SCHEDULER_VERDICT: PASS but no commit landed during the run window
        — the run claims success but produced no code change"
```

**Why:** PRD 874 was written as a pure *verification* PRD — "confirm `faces: ['project']` is
tagged, confirm the regression test exists, confirm ProjectHome has a null-cwd guard". Every one of
those acceptance criteria had already been satisfied by an earlier commit, `a8e063f`
("test(navgroups): lock in project-home as project-only nav destination"), before 874 ever ran:

- `src/renderer/lib/navGroups.ts:36` — `{ key: 'project-home', … faces: PROJECT }` was already there.
- `src/renderer/lib/__tests__/navGroupsHome.test.ts` — already asserts `getNavItemsForFace('home')`
  excludes `project-home`, `getNavItemsForFace('project')` includes it, and `faces === ['project']`.
- `src/renderer/components/tabs/projecthome/ProjectHome.tsx:571-573` — already returns
  `<EmptyState title="Open a project to see its brief" />` when `activeTab` is null.

So there was literally nothing left to change, and a PRD with nothing to change **cannot** satisfy
the scheduler's finish protocol, which requires a truthful `PASS` **plus a commit that landed inside
the run window**. The bug is in the PRD's authoring, not in its execution: a no-op verification PRD
is structurally unpassable.

**The fix is therefore not "re-verify harder."** It is to land the one piece of coverage 874's
acceptance criteria gestured at but never actually asserted — the *runtime* behavior of ProjectHome
under a null cwd, and an invariant that keeps every NAV_ITEM face-tagged — as a real, committed
test diff. Do not simply re-run the verification and PASS again; that reproduces the exact same
`pass_no_commit` outcome.

# What to build

Two additions, both under `src/renderer/`. Both are net-new test code, so this run produces a real
commit.

### 1. `src/renderer/components/__tests__/ProjectHomeEmptyState.test.tsx` (new)

A React Testing Library test that renders `ProjectHome` with **no active tab** and asserts it
renders the empty state rather than throwing on `activeTab.cwd`.

- Follow the existing renderer component-test conventions — read
  `src/renderer/components/__tests__/EpicQueue.test.tsx` and
  `src/renderer/components/__tests__/EpicsWorkspace.test.tsx` first and mirror how they mock the
  zustand stores / IPC (`window.api`) surface. Do not invent a new mocking style.
- `ProjectHome` is at `src/renderer/components/tabs/projecthome/ProjectHome.tsx`; the guard under
  test is the `if (!activeTab) return <EmptyState title="Open a project to see its brief" />` branch
  around line 571.
- Assertions: (a) render does not throw; (b) the text `Open a project to see its brief` is present.
- If mocking the full ProjectHome dependency graph proves genuinely disproportionate (it pulls in
  brief loading, epics, scheduler jobs), fall back to extracting **nothing** and instead assert the
  same invariant at the module level in the pure-logic test file
  `src/renderer/lib/__tests__/projectHomeDerive.test.ts` — but prefer the render test; only fall
  back if you have actually tried and hit a hard blocker, and say so explicitly in the commit body.

### 2. Face-coverage invariant in `src/renderer/lib/__tests__/navGroupsHome.test.ts` (extend existing)

Add cases that make the two-face taxonomy self-policing, so a future NAV_ITEM can't silently ship
untagged:

- Every entry in `NAV_ITEMS` has a non-empty `faces` array.
- Every value inside every `faces` array is a valid `NavFace` (import the type/union source from
  `src/renderer/lib/navFace.ts` — read it first; reuse whatever constant it already exports rather
  than hand-writing a `['home','project']` literal, per the API-reuse standard).
- `getNavItemsForFace('home')` and `getNavItemsForFace('project')` together cover every key in
  `NAV_ITEMS` (union of the two equals the full key set).
- Keep the existing `project-home`-specific assertions intact — do not rewrite the file, extend it.

Do **not** change `navGroups.ts`, `navFace.ts`, or `ProjectHome.tsx` unless a test genuinely proves a
defect. If a new invariant test goes red, that is a real finding: fix the source, and say so in the
commit message.

# Verification commands

Run these in order; the AC gate must be the LAST thing that runs.

```
timeout 300 npm run typecheck
timeout 120 npx vitest run src/renderer/lib/__tests__/navGroupsHome.test.ts
timeout 180 npx vitest run src/renderer/components/__tests__/ProjectHomeEmptyState.test.tsx
timeout 60 npm run lint:selectors
```

Note on the environment: `SM_CHAT_CONCURRENCY` may be exported in the user's shell and can make
unrelated specs red locally — it does not affect these files, so do not chase it.

# Acceptance criteria

- [ ] `src/renderer/components/__tests__/ProjectHomeEmptyState.test.tsx` exists and asserts
      ProjectHome renders the "Open a project to see its brief" empty state when there is no active
      tab (or, only if the render test was genuinely infeasible, the documented fallback assertion
      lands in `projectHomeDerive.test.ts` with the reason stated in the commit body)
- [ ] `src/renderer/lib/__tests__/navGroupsHome.test.ts` additionally asserts: every NAV_ITEM has a
      non-empty `faces`; every face value is a valid `NavFace` sourced from `navFace.ts`; and
      `getNavItemsForFace('home') ∪ getNavItemsForFace('project')` covers every NAV_ITEMS key
- [ ] All pre-existing assertions in `navGroupsHome.test.ts` still pass (file extended, not rewritten)
- [ ] `timeout 300 npm run typecheck` passes
- [ ] `timeout 120 npx vitest run src/renderer/lib/__tests__/navGroupsHome.test.ts` passes
- [ ] `timeout 180 npx vitest run src/renderer/components/__tests__/ProjectHomeEmptyState.test.tsx` passes
- [ ] `timeout 60 npm run lint:selectors` passes
- [ ] **A commit lands during this run** containing the new/changed test files. This is the criterion
      the original run missed — a green verification with no commit is the exact failure being fixed
      here. If you somehow find nothing to commit, that means you did not add the tests: add them.

# Out of scope

- Redesigning ProjectHome, the two-face sidebar, or `getNavItemsForFace`'s API
- Touching the other `87x`/`88x`/`89x` nav-face PRDs in the
  `two-face-leftnav-home-vs-project-scoped-navigati-7edd20cb` epic
- Committing the unrelated pre-existing working-tree churn (scheduler `queue.json`,
  `prompt-sessions/active-index.json`, transcripts, PRD frontmatter edits). Those are owned by other
  surfaces under the single-writer law — stage only your own test files with explicit
  `git add <path>` and never `git add -A` / `git commit -a`.

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

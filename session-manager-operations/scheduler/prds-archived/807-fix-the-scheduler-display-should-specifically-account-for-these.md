---
title: "Fix: surface PRD → prompt-session referential link in the collapsed Scheduler job row"
cwd: /home/bilko/Projects/session-manager
parallelGroup: 807
estimateMinutes: 40
---

# Goal

**Read this first — the previous run of this PRD (slug `807-the-scheduler-display-should-specifically-account-for-these`) failed by
declaring the work already done and shipping nothing.** It exited 0 with
`SCHEDULER_VERDICT: PASS`, **zero commits and zero file edits**, on the reasoning
that `sourcePromptId`/`sourceTabId` frontmatter and a "view prompt session →"
button already exist. Do not repeat that. **The deliverable of this PRD is a code
diff plus a passing unit test.** A run that ends without a commit is a failure
regardless of what it concluded.

## Root cause of the previous failure

- The goal's specification was a screenshot of the Scheduler **Queue tab's collapsed
  job rows**. Those rows render: status badge, `#NNN` PRD badge, title, project tag,
  duration, chevron. **Nothing else.**
- The prompt-session trace link that already exists is rendered *only inside the
  expanded row*, in the `Actions` `DetailBlock`
  (`src/renderer/components/SchedulePanel.tsx`, the `linkedPromptSession && (...)`
  block with `data-testid="job-row-prompt-session-link"`).
- That link is furthermore conditional on `usePromptSessions((s) => s.sessions[job.sourceTabId])`
  resolving to a live session. When the PRD has no `sourceTabId` (every PRD authored
  before that feature landed), or when the session store hasn't hydrated that id, the
  block renders **nothing at all** — no label, no id, no "not linked" state. The user
  cannot tell "this PRD has no source" from "the UI forgot to show it".
- `sourcePromptId` is carried through `prdFrontmatter.ts` → `prdParser.cjs` →
  `scheduler.cjs` onto the runtime job object, but is **never rendered anywhere in the UI**.
- The previous executor confused adjacent shipped commits (`fc72386`, `28a9d09`) for
  completion, gated only on `npm run typecheck` (which is trivially green when you
  change nothing), and never compared the running UI against the screenshot.

# Acceptance criteria

- [ ] **Collapsed job row shows the referential link.** In `JobRow` in
      `src/renderer/components/SchedulePanel.tsx`, the collapsed row (the `<button>` with
      `data-job-row`) renders a compact trace affordance next to the `PrdNumberBadge`,
      showing the originating prompt session. Requirements:
      - When `linkedPromptSession` resolves: render a small clickable chip
        (`data-testid="job-row-prompt-session-chip"`) whose visible text is a truncated
        form of `linkedPromptSession.goalText` (or the short session id if `goalText` is
        empty), with the full `goalText` in `title`. Clicking it must NOT toggle the row
        open — call `e.stopPropagation()` and `e.preventDefault()`, then do the same
        navigation the existing expanded link does (`setPendingPromptSessionId(...)` +
        `window.dispatchEvent(new CustomEvent('sm:navigate', { detail: 'terminal' }))`).
        Because the collapsed row is itself a `<button>`, the chip must be a `<span>`
        with `role="button"`, `tabIndex={0}`, and an `onKeyDown` handler for Enter/Space —
        **not** a nested `<button>` (invalid HTML, and it breaks the row's own click target).
      - When `job.sourcePromptId` or `job.sourceTabId` is set but no session resolves:
        render the same chip in a muted, non-clickable form showing the short id
        (first 8 chars), `data-testid="job-row-prompt-session-chip"`, `title` explaining
        the session is not currently loaded.
      - When neither field is set: render nothing (do not add visual noise to legacy jobs).
- [ ] **Expanded detail exposes the raw referential ids.** In the `Location` `DetailBlock`
      of the expanded panel, add `DetailLine`s for `prompt id` (`job.sourcePromptId`) and
      `source tab` (`job.sourceTabId`), each falling back to `'—'` when absent. Keep the
      existing `group` and `cwd` lines.
- [ ] **Type surface is real.** Confirm the job type used by `SchedulePanel`/`scheduleState`
      declares `sourcePromptId?: string | null` and `sourceTabId?: string | null`. If it does
      not, add them — do not cast with `as any`.
- [ ] **New unit test passes.** Add or extend a vitest spec covering `JobRow`'s three states
      (linked / id-present-but-unresolved / absent). Prefer extending an existing
      `SchedulePanel` spec if one exists (`ls src/renderer/**/*SchedulePanel*.spec.*` /
      `grep -rl "SchedulePanel" src/renderer --include=*.spec.tsx`); otherwise create
      `src/renderer/components/SchedulePanel.jobrow-trace.spec.tsx`. Assert on the
      `data-testid`s above, and assert that clicking the chip does **not** expand the row
      (`aria-expanded` stays `"false"`).
- [ ] `timeout 300 npm run typecheck` passes.
- [ ] `timeout 300 npx vitest run <the spec file you added/changed>` passes.
- [ ] **`git diff --stat HEAD` is non-empty and the work is committed.** A no-op PASS is an
      automatic failure of this PRD.

# Implementation notes

Target project: `/home/bilko/Projects/session-manager`

Key files:
- `src/renderer/components/SchedulePanel.tsx` — `JobRow` (~lines 750–915). The collapsed
  `<button>` uses `grid grid-cols-[116px_1fr_auto_auto]`; the title cell is the `1fr`
  `<div className="min-w-0">` containing `PrdNumberBadge` + `job.title`. Put the chip on
  the line below the title (alongside the existing `note` line) so the grid template
  doesn't need changing.
- `src/renderer/lib/promptSessionDeepLink.ts` — `setPendingPromptSessionId`, the existing
  deep-link mechanism. **Reuse it; do not write a second navigation path.**
- `src/renderer/state/scheduleState.ts` — job type declarations.
- `src/main/scheduler.cjs` (~lines 839, 885) — where `sourcePromptId`/`sourceTabId` are
  copied from parsed PRD frontmatter onto the runtime job. This side is already correct;
  you should not need to change it. Verify with
  `grep -n "sourcePromptId" src/main/scheduler.cjs src/renderer/state/scheduleState.ts`
  before assuming otherwise.
- `src/renderer/lib/prdFrontmatter.ts` — frontmatter round-trip, already carries both fields.

Repo conventions that apply:
- **Never return a freshly-built value from a zustand selector** (`?? []`, `.map`, `.filter`,
  `Object.values` inside the selector) — it causes an infinite re-render → React #185 → blank
  app. The existing `usePromptSessions((s) => job.sourceTabId ? (s.sessions[job.sourceTabId] ?? null) : null)`
  is safe because `null` is a stable primitive; keep any new selector equally primitive-or-raw-slice.
- No backwards-compat shims; just refactor.
- Tests are vitest (`npm run test:unit`), never `node --test`.

# Out of scope

- Changing the PRDs tab or History tab (Queue tab only).
- Changing `notifyOriginatingTab` in `scheduler.cjs` or any main-process behavior.
- Any e2e / Playwright work. Do not launch the Electron app — a headless run cannot drive a GUI.
- Touching the untracked scratch files in the working tree (`*.png`, `*-screenshots.mjs`).

## Engineering standards

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

---
title: Move queue-reconciliation and feedback-sweep from the external watchdog into scheduler.cjs itself
cwd: ~/Projects/session-manager
estimateMinutes: 28
---

# Goal

**Depends on `685-watchdog-app-supervisor.md` — do not start until it has landed and its
relaunch capability is confirmed working** (verify via
`git log --oneline -- scripts/scheduler-watchdog.cjs` before proceeding; if that PRD's commit
isn't present, halt with `SCHEDULER_VERDICT: FAIL blocked-on-685-supervisor`). The reasoning: once
685 guarantees the app relaunches within ~2-4 minutes of going down, there's never a long window
where "app is down AND nothing does queue/feedback reconciliation" — so it becomes safe to stop
duplicating that logic in an external always-separate script and instead let the one process that
actually owns `queue.json` and the scheduler loop (`src/main/scheduler.cjs`, running inside the
app) do it on its own boot and its own polling cadence.

Today, `reconcileQueueOffline()` (reaping orphaned `running` jobs whose pid died while Electron
wasn't running) and `sweep()` (scanning recently-active project transcripts via
`activeProjectCwds()`, emitting auto-PRDs for open feedback) live entirely in
`scripts/lib/watchdogHelpers.cjs` / `scripts/lib/activeSessions.cjs` — a second codebase, running
as a separate Node process outside the Electron app, that has to re-implement its own reading of
`queue.json`'s shape, its own run-outcome classification, and its own feedback-folder scanning,
all logic that already exists (or has close cousins) inside `scheduler.cjs` per this project's own
CLAUDE.md ("Boot reconciliation: on startup, reaps orphaned jobs... Dead-process reaper..."). This
is the exact "N display sites, one source" violation this project's standards call out — the
same queue-health concept implemented twice, in two places, that can silently drift.

This PRD folds `sweep()`'s feedback-auto-PRD responsibility into `scheduler.cjs`'s own already-
running poll loop (it already polls every 60s in `when-available` mode per CLAUDE.md), and
confirms/hardens `scheduler.cjs`'s existing boot-time reconciliation fully subsumes what
`reconcileQueueOffline()` did — then strips both out of the external watchdog script, leaving it
with exactly the one job PRD 685 gave it: is the app alive, and if not, start it.

# Acceptance criteria

- [ ] Read `src/main/scheduler.cjs`'s existing boot-reconciliation code (per CLAUDE.md: "on
  startup, reaps orphaned jobs (PIDs no longer alive) and logs outcome") and diff its behavior
  against `scripts/lib/watchdogHelpers.cjs`'s `reconcileQueueOffline()` (orphan pid-liveness check
  → SIGTERM/SIGKILL escalation for jobs whose pid is somehow still alive but orphaned from the
  queue's perspective, run-log classification via `classifyRunOutcome`, atomic `queue.json`
  rewrite, `ORPHAN_REQUEUE_CAP` bound). Where `scheduler.cjs`'s boot reconciliation is missing a
  behavior the offline version has (e.g. the SIGTERM→SIGKILL escalation for a still-alive orphaned
  pid, or the `ORPHAN_REQUEUE_CAP` bound), port that specific behavior into `scheduler.cjs`'s boot
  path — reuse the same `classifyRunOutcome` function (import it, don't fork it) rather than
  reimplementing classification logic a second time in-app.
- [ ] Move the feedback-auto-PRD responsibility (`sweep()`'s `activeProjectCwds()` →
  `hasOpenFeedback()` → `emitFeedbackPRD()` chain) into `scheduler.cjs`'s existing 60s poll tick —
  add it as one more step in that loop (gated so it only runs, say, every Nth tick or on its own
  slower interval within the same loop, matching `sweep()`'s existing 90-minute activity window so
  behavior doesn't change, just where it runs from). Import and reuse
  `scripts/lib/activeSessions.cjs`'s `activeProjectCwds` and the feedback-detection/PRD-emission
  helpers directly (they're plain Node modules, not tied to the external-script context — importing
  them from `scheduler.cjs` should be straightforward; if any of them assume `process.argv`/CLI
  context that breaks when imported, extract the reusable core into a function and keep only true
  CLI-entrypoint code in the `scripts/` file, following this repo's existing lib/entrypoint split
  convention).
- [ ] Once both are confirmed working from inside `scheduler.cjs` (covered by the tests below),
  remove `reconcileQueueOffline()`'s call site and `sweep()`'s call site from
  `scripts/scheduler-watchdog.cjs`'s main tick function — leave only the liveness-check +
  relaunch logic PRD 685 added. Delete `reconcileQueueOffline`/`sweep`/`activeProjectCwds` (and any
  now-unused supporting code) from `scripts/lib/watchdogHelpers.cjs`/`activeSessions.cjs` if
  nothing else references them after the move (grep to confirm before deleting — don't leave dead
  code per this repo's "no backwards-compat shims" convention, but also don't delete something a
  test or another script still imports).
- [ ] Add/extend unit tests: `scheduler.cjs`'s boot path reaps an orphaned job the same way the
  old offline version did (test the ported SIGTERM/SIGKILL-escalation + `ORPHAN_REQUEUE_CAP`
  behavior specifically, since that's the part most likely to have subtle differences); the 60s
  poll tick emits a feedback PRD for a project with open feedback and a recent transcript, and does
  NOT emit one for a project outside the 90-minute activity window or with no open feedback
  (mirror whatever test cases already exist for `sweep()`, don't weaken coverage in the move).
- [ ] Confirm `scripts/scheduler-watchdog.cjs`'s remaining responsibility (post-685, post this PRD)
  is exactly: liveness-check heartbeat → relaunch-if-dead. Nothing else. Update the file's header
  comment to state this plainly (mirroring the style of this project's other `.cjs` file-header
  doc comments) so a future reader doesn't reintroduce queue logic into it.
- [ ] `timeout 300 npm run typecheck` passes.
- [ ] `timeout 120 npx vitest run <files you touched in src/main/scheduler.cjs and its specs>`
  passes.

# Implementation notes

- Read `scripts/lib/watchdogHelpers.cjs:213-348` (`reconcileQueueOffline`) and
  `scripts/lib/watchdogHelpers.cjs:600-635` (`sweep`) end to end before touching `scheduler.cjs` —
  you need the exact behavior to port, not an approximation.
- Read `scripts/lib/activeSessions.cjs:62-87+` (`activeProjectCwds`) for its exact transcript-scan
  logic (90-min window default, `fs.statSync` existence check) — reuse verbatim.
- `scheduler.cjs` is large (per CLAUDE.md, it already owns modes, boot reconciliation, the
  dead-process reaper, and the heartbeat write at line ~241/3084-3093) — find its existing boot
  reconciliation function and existing poll-tick function first (grep for the heartbeat-write
  line as an anchor, then look at what runs in the same tick) rather than guessing where to splice
  in the new logic.
- This PRD is explicitly about **consolidation**, not new behavior — the feedback-sweep and
  orphan-reap semantics (90-min window, `ORPHAN_REQUEUE_CAP`, SIGTERM→SIGKILL escalation) must
  come out identical to today's, just relocated. Resist the temptation to "improve" the logic
  while moving it; that's a different PRD if warranted later.

# Out of scope

- Do not touch the liveness-check/relaunch logic PRD 685 adds to the watchdog — that stays exactly
  as 685 built it; this PRD only removes the *other* two responsibilities from the same file.
- Do not change `queue.json`'s schema or the concurrency cap (stays 3).
- Do not change the feedback-PRD emission format/dedup logic itself — only where it's invoked
  from.
- Do not remove the systemd timer or its 2-minute cadence — the watchdog still ticks that often,
  it just now does less work per tick.

## Engineering standards

# Engineering standards

> Single source of truth for the developer guidance that used to live in the global
> `~/.claude/CLAUDE.md`. Consumers: the `/develop` skill reads it while planning and
> inlines it **verbatim** into every PRD it emits (under an `## Engineering standards`
> heading); the `/prd` command points here for the execution-discipline rules so a
> directly-authored PRD carries the same block. The headless `claude -p` executor sees no
> skills and no conversation — inlining this is the only way these rules reach it. Edit
> here once; every call site updates.
>
> The **Execution discipline** section below is the executor-facing core — it is the part
> that MUST appear in every PRD body. The rest (Performance, Debugging, API reuse, TDD)
> guides authoring and interactive work.

## Performance

- State the time and space complexity of any non-trivial algorithm in a comment.
- Flag any nested loop over user-scaled data as a complexity hazard.
- Prefer O(n) solutions over O(n log n) only when n is provably small or constant.
- Lay out hot data contiguously and traverse it in memory order.
- Prefer arrays of structs or structs of arrays based on actual access patterns.
- Avoid pointer-chasing in inner loops on large datasets.

## Debugging approach

- State an explicit hypothesis before each debugging action.
- Describe what observation would confirm or refute the hypothesis.
- If three hypotheses fail, stop and re-examine your assumptions from scratch.
- When a bug was recently introduced, bisect commits to find the offender.
- When a bug is in a long pipeline, halve the input or code path until it localizes.
- Record each bisection step so the path to the root cause is reproducible.
- Never attempt a fix until you can reproduce the bug on demand.
- Capture the reproduction as a failing test before changing production code.
- If the bug cannot be reproduced, instrument the system until it can.

## API reuse and single source of truth

- One concept = one implementation. Before writing code that computes, fetches, formats, or displays a value, search the codebase for an existing implementation and reuse it. Do not write a second or third copy of the same logic.
- N display sites, ONE source. When the same datum appears in multiple places (a metric shown in several tabs, a value returned by several endpoints), it must flow from a single shared accessor / store / hook / endpoint. Displaying something in 3 places must not mean 3 implementations — it means 1 implementation with 3 call sites.
- Extend, don't fork. If an existing function/module/API is close but not sufficient, generalize it (add a param, widen the contract) rather than cloning a divergent variant. Prefer composition over duplication.
- Treat duplication as a latent bug. Copy-pasted logic drifts; divergence between copies is how silent inconsistencies ship (e.g. one site reads a 0–100 percentage as a 0–1 fraction). When you see the same logic in two places, consolidate it on sight and route both through the shared unit.
- Design for extensibility: stable shared contracts, single ownership, callers depend on the contract — not on a private copy. New surfaces consume the canonical API; they never reimplement it.
- When reviewing or implementing, explicitly check: "is this value/behaviour already produced elsewhere, and am I reusing that path?" If not, fix the reuse before adding the feature.

## Test-driven development

- Write the failing test first, then the implementation that makes it pass — for every feature and every bugfix.
- A bugfix starts with a test that reproduces the bug (red), then the fix (green).
- Do not write production code without a test asserting the behavior it adds.
- (Interactive sessions: the `test-driven-development` skill has the full red-green-refactor
  workflow. Headless PRD runs can't load it — the three rules above are the load-bearing core.)

## Visual design (UI/visual acceptance criteria)

When a PRD's acceptance criteria touch UI or visual output and no design brief is given,
resolve the visual direction in this priority order — never substitute a generic default when
a higher-priority source exists:

1. **User-supplied design.** If the PRD or the conversation that spawned it includes a design
   brief, mockup, brand palette, or explicit visual direction, use it verbatim.
2. **Existing project design system.** Before reaching for any external skill, check the repo
   itself for an existing theme — CSS custom-property blocks, `tailwind.config.js`, a
   design-tokens file, a component library already in use. Reuse and extend what's there
   rather than introducing a second visual language into the same project.
3. **Only if neither exists**, invoke a design-oriented skill rather than eyeballing colors
   from memory or hand-picking hex values (e.g. the bundled `dataviz` skill for
   chart/table/dashboard work, or a `frontend-design`-class skill for overall aesthetic
   direction) — and **render + screenshot both light and dark color-scheme modes** before
   calling the work done. A palette validator that checks categorical/series colors does not
   cover surrounding chrome tokens (panel/page/border) — those need their own contrast check
   (WCAG relative luminance) and a visual look in each mode. "I checked light mode" is not "I
   checked dark mode"; verify both, don't assume palette-reference hex values are safe by
   construction. (Incident: a dashboard shipped with panel/page background contrast of
   1.12:1 and a border at 1.34:1 in dark mode — both invisible — because only light mode was
   ever rendered before the work was marked done.)

## Execution discipline (headless runs)

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
- **Finish so the verifier auto-clears you.** The scheduler appends a finish protocol that requires you to COMMIT your work and emit `SCHEDULER_VERDICT: PASS` (or `FAIL <reason>` + `exit 1`) as the literal last line. Honor it exactly: a *truthful* PASS plus a commit that landed during the run is what lets the verifier override incidental transcript noise (a grep hit containing "Error", a TDD red-phase run, a debug Traceback) instead of parking the job in `needs_review` for a human. A job that exits 0 with **uncommitted** changes, or with no PASS sentinel, is the #1 cause of needless `needs_review`. Never print PASS on a red gate — a lying PASS turns the verifier into a silent-failure shipper.
- **Don't leak expected-error text into tool output.** The verifier pattern-matches transcript content for `Traceback`/`FAIL`/`Error:`. When a step is *expected* to error (a TDD red-phase test, an availability/existence probe, a "should raise" assertion), don't let the raw exception land verbatim — capture it and surface a clean token instead: `if python -c '…' 2>/dev/null; then echo PROBE_OK; else echo PROBE_ABSENT; fi`, or pipe the noisy run through a matcher that prints only `RED (expected)` / `GREEN`. When you retry a transient failure, re-run the **same command with the same description** — the verifier's self-recovery detector pairs a failed call with a later identical-description call that succeeds and clears it.
- **End green: run the acceptance/test gate LAST, and let nothing error after it.** The post-run verifier scans the transcript and downgrades to `needs_review` on error markers — and weighs the *final* portion of the run most heavily (a tool error in the last ~20% trips it even if everything actually passed). So order the run so the last command is the green AC gate: do any intentionally-failing step (e.g. a TDD red test, an expected-nonzero probe) **early**, never after the gate. If you must demonstrate a failure late, capture it so it doesn't surface as a raw `is_error`/`Traceback` (`… 2>&1 | tail` inside a conditional, or assert on the captured text) rather than letting it hit the transcript bare.
- **The verdict sentinel is your authoritative "I passed" signal — emit it truthfully.** The scheduler appends a FINISH PROTOCOL that ends by printing `SCHEDULER_VERDICT: PASS` once the AC gate is green and the commit has landed (or `SCHEDULER_VERDICT: FAIL <reason>` + `exit 1` otherwise). The verifier treats `PASS` + a commit that landed during the run as **authoritative** and overrides incidental transcript markers — so a *deliberately reproduced* red test (systematic-debugging) or a grep result containing the word "Error" will **not** false-trip `needs_review`, as long as the run genuinely ends green and committed. Never print `PASS` when the gate is red — that's the one thing that turns a safety net into a silent-failure machine.

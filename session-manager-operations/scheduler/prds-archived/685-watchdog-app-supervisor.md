---
title: Repurpose scheduler-watchdog into a pure app-supervisor (start session-manager if not running)
cwd: ~/Projects/session-manager
estimateMinutes: 25
---

# Goal

Today `scripts/scheduler-watchdog.cjs` (installed as a systemd `--user` timer,
`scheduler-watchdog.timer`, firing every 2 minutes per `scripts/install-scheduler-watchdog.sh`)
has exactly one kind of responsibility: scheduler-queue-internals work that only matters *while
Electron is not running* — `reconcileQueueOffline()` (reap orphaned `running` jobs in
`queue.json`) and `sweep()` (scan recently-active project transcripts via `activeProjectCwds()`,
emit auto-PRDs for open feedback). It has **zero** capability to launch or supervise the
session-manager app itself (confirmed: no `spawn`/`exec`/`npx`/`claude-code-session-manager`
reference anywhere in `scripts/scheduler-watchdog.cjs`, `.sh`, or `scripts/lib/watchdogHelpers.cjs`).

This is backwards from what an external watchdog is naturally good for. A `systemd --user timer`
firing every 2 minutes is the *right* tool to answer "is the long-running app I depend on still
alive, and if not, start it" — that's a supervision concern, and today nothing does it: if
session-manager crashes, gets killed, or the machine reboots, it stays down until a human
notices and manually relaunches it. Meanwhile the scheduler-internals work
(`reconcileQueueOffline`/`sweep`) is queue/feedback domain logic that has no real reason to live
outside the app that already owns `queue.json` and the scheduler loop — it's an inline job for
`scheduler.cjs` itself, done at its own boot time and on its own polling cadence, not a separate
script's concern (that move is PRD 686, sequenced after this one).

**This PRD's job**: add app-liveness detection + auto-launch to the watchdog script, so "session
manager is always up" becomes true without a human ever needing to relaunch it. PRD 686 will
follow up and strip the queue/feedback logic back out once this supervisor role is proven, per
the user's explicit direction: "The system watch-dog should be only to start session manager if
one does not exist."

# Acceptance criteria

- [ ] Add a liveness check to `scripts/scheduler-watchdog.cjs` (or a new small helper in
  `scripts/lib/`, matching this repo's existing module-per-concern layout in that directory) that
  determines whether session-manager is currently running. Reuse the **existing** heartbeat
  mechanism already read by `readLastHeartbeatTs`/`heartbeatFresh` in
  `scripts/lib/watchdogHelpers.cjs` (`DEFAULT_HEARTBEAT_PATH` =
  `~/.claude/session-manager/scheduler-heartbeat.log`, `DEFAULT_MAX_AGE_MS = 180_000`) — do NOT
  invent a second heartbeat/liveness file. That heartbeat is written every 60s by the running
  app's `scheduler.cjs` (`HEARTBEAT_PATH`, line ~241) regardless of pause state, so "heartbeat
  fresh within the existing max-age window" is already an accurate "app process is alive" signal
  — confirm this by reading `scheduler.cjs`'s heartbeat-write code before proceeding, don't assume.
- [ ] When the heartbeat is stale (by the existing `heartbeatFresh()` threshold) AND
  (defense-in-depth) the last-known pid recorded in the heartbeat file is not alive
  (`process.kill(pid, 0)` — same check `reconcileQueueOffline` already uses, reuse it, don't
  reimplement), launch a new session-manager instance: spawn it **detached** (so it survives the
  watchdog script's own exit) via the same launch path a user would use —
  `npx claude-code-session-manager@latest` if that resolves, matching this project's documented
  distribution method (`CLAUDE.md`'s "Distribution" section) — with stdio ignored/redirected to a
  log file under `~/.claude/logs/` (follow the naming convention of this repo's other watchdog
  logs, e.g. `~/.claude/logs/scheduler-watchdog-relaunch.log`), and `.unref()` it so the watchdog
  process (which exits promptly) doesn't block on it.
- [ ] Debounce relaunches: track the last relaunch attempt in a small state file (e.g.
  `~/.claude/session-manager/watchdog-relaunch-state.json` with `{ lastAttemptTs, attemptCount }`)
  and skip relaunching if the previous attempt was less than ~90 seconds ago (a fresh launch takes
  time to boot Electron and write its first heartbeat — relaunching every 2-minute tick before
  that happens would pile up duplicate launches, which PRD 685's sibling
  `685-single-instance-lock-forced-exit.md` fix makes safe to attempt but still wasteful/noisy to
  do repeatedly). Reset `attemptCount` once a fresh heartbeat is observed.
- [ ] Cap relaunch attempts: if 3 consecutive relaunch attempts (each ≥90s apart) all fail to
  produce a fresh heartbeat within a reasonable window (e.g. 3 minutes each), stop attempting and
  log a clear diagnostic line (don't loop forever silently retrying a launch that's failing for a
  real reason, e.g. a broken npm install) — this mirrors this project's existing "dead-process
  reaper" bounded-retry philosophy (`CLAUDE.md`'s scheduler.cjs section) rather than inventing a
  new retry policy shape.
- [ ] Add unit tests (extend whatever spec file already covers `watchdogHelpers.cjs` — search
  `find scripts -iname '*watchdog*spec*' -o -iname '*watchdog*test*'` first) covering: fresh
  heartbeat → no relaunch; stale heartbeat + dead pid → relaunch fires (stub the actual spawn);
  stale heartbeat but debounce window not elapsed → no relaunch; 3 failed attempts → stops
  attempting and logs, does not attempt a 4th.
- [ ] `timeout 300 npm run typecheck` passes (if this script directory is covered by typecheck —
  confirm via the existing `tsconfig`/`package.json` scope; if `scripts/` is plain untyped `.cjs`
  outside typecheck's scope, say so and skip this specific check rather than forcing it).
- [ ] `timeout 120 npx vitest run <files you touched>` passes.

# Implementation notes

- Read `scripts/lib/watchdogHelpers.cjs` in full first, specifically `readLastHeartbeatTs`/
  `readLastHeartbeat`/`heartbeatFresh` (lines ~49-100) and the pid-liveness check inside
  `reconcileQueueOffline` (lines ~229-237) — reuse both verbatim rather than re-deriving them.
- Read `scripts/scheduler-watchdog.sh`'s `flock -n /tmp/sm-scheduler-watchdog.lock` wrapper — your
  new relaunch logic runs inside the same flock-guarded tick, so you get "only one watchdog tick
  running at a time" for free; don't add a second lock.
- The companion PRD `685-single-instance-lock-forced-exit.md` (same parallel group, different
  files — `index.cjs` vs these `scripts/` files, no merge conflict) fixes the case where this
  PRD's relaunch races a session-manager instance that's actually still alive but hasn't written
  a fresh heartbeat yet: after that fix, the spurious second launch cleanly self-terminates via
  the single-instance lock instead of zombie-ing. Both PRDs are complementary safety nets; you
  don't need to wait for the other to land before implementing this one, but mention the
  relationship in your commit message.
- `CLAUDE.md`'s existing "Distribution" section documents `npx claude-code-session-manager@latest`
  as the standard launch method — use that exact invocation rather than trying to locate a local
  binary path, so this keeps working after npm publishes new versions without any path updates
  needed here.

# Out of scope

- Do NOT remove `reconcileQueueOffline()` or `sweep()`/`activeProjectCwds()` from the watchdog
  script in this PRD — that removal is PRD 686, sequenced to run after this one lands (it depends
  on this PRD's relaunch capability existing first, so there's never a gap where the app is down
  AND nothing does queue/feedback reconciliation). This PRD only *adds* the liveness+relaunch
  capability; it does not delete anything yet.
- Do not change `install-scheduler-watchdog.sh`'s timer cadence (stays at 2 minutes) or its
  systemd-vs-cron fallback logic.
- Do not add a GUI/notification for relaunch events beyond the log line described above.
- Do not change `index.cjs`'s single-instance-lock code — that's PRD 685's sibling file, out of
  scope here.

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

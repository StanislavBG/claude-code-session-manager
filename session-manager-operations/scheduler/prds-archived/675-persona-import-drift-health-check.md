---
title: Health check flags broken @import targets and stale persona repos in ~/.claude/CLAUDE.md
cwd: ~/Projects/session-manager
estimateMinutes: 20
---

# Goal

Claude Code's `@path` import syntax in `~/.claude/CLAUDE.md` resolves a missing/moved import
target to *nothing*, with zero warning — if a persona file referenced by `@/home/.../foo.md`
is renamed, deleted, or its containing repo isn't checked out on this machine, every session
silently loses that entire block of instructions and nothing surfaces it (feedback item
`session-manager-operations/feedback/2026-07-21-agent-persona-registry-and-sync.md`; the filer
verified this by hand — removing an imported file produces no error in a new session). Ship
just the highest-value piece the filer identified: an integrity check, surfaced in this
project's own `npm run health` rollup (`src/main/health.cjs`), that (a) asserts every
`@import` target in `~/.claude/CLAUDE.md` resolves to an existing, non-empty file, and (b) for
each unique git repo those imports live in, reports ahead/behind vs. its upstream so stale
local checkouts are visible. No new config surface is needed — the check derives its target
list by parsing `~/.claude/CLAUDE.md` itself, recursively following any `@import`s inside
imported files too.

# Acceptance criteria

- [ ] Add a new function `checkPersonaImports()` in `src/main/health.cjs` (or a small sibling
      module it requires, following the existing `evaluateTickLiveness`/`readFreshHeartbeat`
      pattern of pure, independently-testable functions) that:
      1. Reads `~/.claude/CLAUDE.md` (skip cleanly, `ok: true`, if the file doesn't exist —
         not every machine has one).
      2. Extracts every `@<path>` import reference (a line starting with `@` followed by an
         absolute or `~`-relative path — grep the file's actual current content first to
         confirm the exact syntax bilko's file uses before hardcoding a regex).
      3. Resolves `~` to `os.homedir()`, then for each resolved path: checks it exists and is
         non-empty (`fs.statSync(...).size > 0`). Recursively repeats steps 2-3 on each
         resolved file's own content (imports can chain, per the feedback item's example
         `~/.claude/CLAUDE.md` → `shared/core.md` → `Developer/developer_sg.md`), capping
         recursion depth at a small constant (e.g. 5) to guard against a cyclic-import
         pathological case.
      4. For each unique directory among the resolved paths, walks upward to find a `.git`
         dir (bounded walk, stop at `os.homedir()` or filesystem root); if found, runs
         `git -C <repo> rev-list --left-right --count HEAD...@{upstream}` (wrapped in
         `execFileSync` with a short timeout, swallow/annotate on any failure — no upstream
         configured, network unavailable, detached HEAD — as a non-fatal caveat, never a
         thrown error) to report ahead/behind counts.
- [ ] Wire it into `check()` as a new `status.components.persona_imports` entry, **not** added
      to the `criticalComponents` list at `src/main/health.cjs:311` — a broken/stale persona
      import degrades instruction fidelity, not app health, so it must be informational (like
      `app_logs`/`transcripts_dir`) and never flip `status.ok` to `false`. Still push a
      human-readable line into `status.issues` for each broken import found, so it's visible
      without failing the health gate.
- [ ] TDD, red first: write unit tests (new file, e.g. `tests/unit/personaImportHealth.spec.ts`,
      or add to an existing health-adjacent spec if one exists — grep first) covering: (a) no
      `CLAUDE.md` present → `ok: true`, no issues; (b) all imports resolve and are non-empty →
      `ok: true`; (c) an import path that doesn't exist → issue pushed, `persona_imports.ok`
      false, but `status.ok` (overall) still true; (d) a chained import (file A imports file B
      which imports file C) all resolving correctly; (e) recursion depth cap actually stops a
      cyclic self-import from hanging or stack-overflowing. Use a temp directory fixture for
      the `CLAUDE.md`/imported files, not the real `~/.claude/CLAUDE.md` — tests must not
      depend on or mutate the developer's actual home directory config.
- [ ] `timeout 300 npm run typecheck` and `timeout 300 npx vitest run tests/unit/personaImportHealth.spec.ts` pass.
- [ ] `timeout 60 node src/main/health.cjs` still exits 0 (or whatever its current exit code is
      for this machine) and its JSON output includes a `persona_imports` key — run this as a
      live smoke check against the real `~/.claude/CLAUDE.md`, read-only.
- [ ] After landing, move
      `session-manager-operations/feedback/2026-07-21-agent-persona-registry-and-sync.md`
      to `session-manager-operations/feedback/processed/` with a `## Resolution` section
      naming the commit and explicitly noting pieces 2 (scheduled pull) and 3 (persona
      revision stamped on jobs) were deferred as out of scope for this PRD (per the filer's
      own "piece 1 alone would be worth shipping" framing).

# Implementation notes

- Read `src/main/health.cjs:1-70` first — `runCheck`, `readFreshHeartbeat`, and
  `evaluateTickLiveness` are the established style: pure functions taking explicit inputs
  (not reaching into global state), exported individually for unit testing (see the
  `module.exports` at the bottom of the file). Follow that shape for `checkPersonaImports`.
- Do NOT invent a new config surface for "which persona repos to watch" — the filer explicitly
  left that open and it isn't needed: parsing `~/.claude/CLAUDE.md`'s own `@import` lines
  (recursively) already gives the complete, correct target list with zero configuration.
- Do NOT add a `git fetch` (network call) inside the health check — that's slow, can hang on a
  bad network, and isn't needed for the ahead/behind count if a `git fetch` already ran
  recently as part of normal dev workflow; `rev-list HEAD...@{upstream}` reports against
  whatever the local remote-tracking ref already has cached. If `@{upstream}` isn't
  configured, catch that specific git error and annotate `noUpstream: true` rather than
  treating it as a health failure.
- This is explicitly piece 1 only (drift + integrity check) from the feedback item's three
  suggested pieces — pieces 2 (scheduled `git pull --ff-only`) and 3 (stamping persona SHA on
  scheduler jobs) are separate, larger changes with open design questions the filer left
  unresolved; do not attempt them here.

# Out of scope

- Scheduled `git pull --ff-only` on persona repos before a queue drain (feedback item's piece 2).
- Recording persona repo HEAD SHA on scheduler job metadata (feedback item's piece 3).
- A UI surface in `/project-status` beyond what `npm run health`'s existing JSON already
  provides — `project-status-local`/`/project-status` already reads this project's health
  output, so no separate wiring is needed there.
- Any change to how `~/.claude/CLAUDE.md` itself is authored or its import resolution — this
  is a read-only diagnostic, never a writer of that file.

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
</content>

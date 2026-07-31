---
title: "Fix: register scripts/__tests__ node:test files with vitest and archive the already-landed 672 PRD"
cwd: /home/bilko/Projects/session-manager
parallelGroup: 672
estimateMinutes: 25
---

# Goal

Two small, concrete defects left behind by the `672-fix-feedback-session-manager` run:

1. `vitest.config.ts` does not include any of the four `scripts/__tests__/*.test.cjs` files, so
   `npm run test:unit` covers none of them and any acceptance criterion that says
   `npx vitest run scripts/__tests__/<file>.test.cjs` fails with `No test files found, exiting
   with code 1` even though the suites are fully green under `node --test`. Register them (or
   port them) so the repo's one documented unit-test command actually exercises them.
2. The already-completed PRD `session-manager-operations/scheduler/prds/672-fix-feedback-session-manager.md`
   is still live and untracked in the active `prds/` dir, so the scheduler can fire it a third
   time. Archive it and commit the archive move.

# Root-cause analysis (what went wrong and why)

Scheduled job `672-fix-feedback-session-manager` ran at 2026-07-31T07:37 UTC, exited 0 in 84s
with a truthful `SCHEDULER_VERDICT: PASS`, and was still flagged for investigation.

**This is NOT the "delegated instead of executed" failure class.** The run invoked no `Skill`
tool, no `session-manager-dev:develop`, no `session-manager-dev:process-feedback`, and no
`ScheduleWakeup`. Do not write a fix aimed at self-delegation.

**Why it was flagged:** the work PRD 672 asked for had *already landed* in commits `ed30a12` and
`b4bfaf5`, before this run started. Verified in the current tree:

- `scripts/lib/watchdogHelpers.cjs:151` defines `listSkillCandidates(cwd, skillName, fileName,
  pluginCacheRoot)` and `:175` defines `resolveSkillFile(...)`; both are exported at `:813-814`.
- `emitFeedbackPRD` resolves the inlines through the resolver at `:315` (`process-feedback`
  `SKILL.md`) and `:318` (`develop` `standards.md`), honoring explicit overrides.
- The hard-fail guard exists: `:387-395` builds the `tried` candidate list for whichever inline
  is empty and returns `{ emitted: false, reason: 'missing-inline' }` without writing a file.
- The poisoned `~/.claude/session-manager/scheduled-plans/prds/672-feedback-session-manager.md`
  is already absent.

So the executor correctly found nothing left to implement, made no commit, and PASSed. The
post-run verifier's `pass_no_commit` heuristic saw PASS-with-no-commit-in-window and downgraded
it to `needs_review`. That verifier gap is **already covered by queued PRD
`817-verifier-exempt-already-landed-slug-reruns`** (which adds the already-landed-slug exemption
in `src/main/runVerify.cjs` plus a terminal-status guard on `resetJobFields` in
`src/main/scheduler.cjs`). **Do not re-implement any part of 817 here** — no edits to
`runVerify.cjs` or to `resetJobFields`.

**The genuinely unfixed defect** is the one the executor had to work around out loud. PRD 672's
verification command was:

```
timeout 300 npx vitest run scripts/__tests__/feedback-sweep.test.cjs scripts/__tests__/watchdog-helpers.test.cjs
```

That command cannot pass. `vitest.config.ts` uses an explicit `test.include` allowlist (flat list
of `src/main/**` `.test.cjs` paths plus globs for `tests/unit/**/*.spec.ts` and
`src/renderer/**/*.test.ts{,x}`). `grep -n scripts vitest.config.ts` returns nothing, so a
positional filename filter matches no included file and vitest exits 1 with `No test files
found`. The executor substituted `node --test` and said so in its finish output — a substituted
verification, the same pattern PRD `816-vitest-register-runverify-test` fixes for
`src/main/__tests__/runVerify.test.cjs`.

Consequence beyond this one job: the four watchdog/feedback-sweep suites — the tests that guard
`emitFeedbackPRD`'s `missing-inline` refusal and the skill-path resolver, i.e. the exact code
672 was about — run in **no** standing gate. `npm run test:unit` skips them entirely, so a
future regression in `watchdogHelpers.cjs` ships green.

Third, smaller defect: `672-fix-feedback-session-manager.md` is still sitting untracked in
`session-manager-operations/scheduler/prds/` after completing. A live PRD in the active dir is
re-firable, which is how this slug got a second run in the first place.

# Concrete fix steps

All paths relative to `/home/bilko/Projects/session-manager`.

## 1. Read the current state first

```
timeout 60 sed -n '1,45p' vitest.config.ts
timeout 60 ls scripts/__tests__/
timeout 60 head -20 scripts/__tests__/feedback-sweep.test.cjs
```

The four files to register are:

- `scripts/__tests__/feedback-sweep.test.cjs`
- `scripts/__tests__/watchdog-helpers.test.cjs`
- `scripts/__tests__/watchdog-relaunch.test.cjs`
- `scripts/__tests__/active-sessions.test.cjs`

All four are CommonJS and start with `const { test } = require('node:test');` plus
`require('node:assert/strict')`.

## 2. Add the four paths to `vitest.config.ts`'s `test.include`

Append them as four explicit entries to the existing flat `include` array, following the same
explicit-path convention the ~30 `src/main/__tests__/*.test.cjs` entries already use. **Do not**
switch to a glob like `scripts/__tests__/**/*.test.cjs` — the allowlist is explicit on purpose so
files not designed for the vitest runner aren't pulled in.

## 3. Make each file actually run under vitest

`vitest.config.ts` sets `globals: true`, so bare `test()` resolves to vitest's global. The
question is whether `require('node:test')` shadowing that global still collects correctly under
vitest. Try it first, per file:

```
timeout 120 npx vitest run scripts/__tests__/feedback-sweep.test.cjs
timeout 120 npx vitest run scripts/__tests__/watchdog-helpers.test.cjs
timeout 120 npx vitest run scripts/__tests__/watchdog-relaunch.test.cjs
timeout 120 npx vitest run scripts/__tests__/active-sessions.test.cjs
```

- If a file collects and all its assertions run and pass — done, no rewrite needed.
- If it reports 0 tests, or `node:test`'s runner self-executes outside vitest's collection so
  vitest sees no tests, convert **that file only** to vitest's API: drop the
  `require('node:test')` line and use the injected global `test`/`describe`; keep
  `require('node:assert/strict')` assertions as they are (vitest does not object to `assert`) so
  the diff stays minimal and coverage stays identical. Do not rewrite assertions into `expect()`
  wholesale — equivalent coverage with the smallest diff is the goal.
- Keep the `// Run: timeout 120 node --test …` header comments accurate: if a file still runs
  under both runners leave the comment; if you converted it, update the comment to the vitest
  command.

Note `scripts/__tests__/feedback-sweep.test.cjs` writes into `fs.mkdtempSync` fixtures and must
keep doing so — it must never touch the real `~/.claude` tree. Do not weaken that isolation to
make it pass. `scripts/__tests__/installer-idempotent.sh` is a shell script, not a test file —
leave it alone.

## 4. Archive the completed 672 PRD

The PRD that this fix-plan supersedes has already run twice and completed. Move it out of the
active dir so it cannot fire again:

```
mkdir -p session-manager-operations/scheduler/prds-archived
git mv session-manager-operations/scheduler/prds/672-fix-feedback-session-manager.md \
       session-manager-operations/scheduler/prds-archived/672-fix-feedback-session-manager.md \
  2>/dev/null \
  || mv session-manager-operations/scheduler/prds/672-fix-feedback-session-manager.md \
        session-manager-operations/scheduler/prds-archived/672-fix-feedback-session-manager.md
```

(The file is currently **untracked**, so `git mv` will fail — the `mv` fallback is the expected
path. Then `git add` the archived location so the move is recorded.)

Do **NOT** delete or archive this fix-plan PRD (`672-fix-fix-feedback-session-manager.md`) — you
are executing it.

## 5. Commit

Commit `vitest.config.ts`, any converted test files, and the archived PRD together. This run must
end with a commit that landed during the run.

# Verification commands

Run in this order; the AC gate is last and must end green.

```
timeout 300 npm run typecheck
```

```
timeout 180 npx vitest run scripts/__tests__/feedback-sweep.test.cjs scripts/__tests__/watchdog-helpers.test.cjs scripts/__tests__/watchdog-relaunch.test.cjs scripts/__tests__/active-sessions.test.cjs
```

That command must exit 0 **and** report a non-zero number of passing tests — `No test files
found` or `0 passed` is a FAIL, not a pass. Assert it explicitly:

```
timeout 180 npx vitest run scripts/__tests__/feedback-sweep.test.cjs 2>&1 | tee /tmp/vt.txt >/dev/null
if grep -q "No test files found" /tmp/vt.txt; then echo "HALT: vitest still not collecting scripts/__tests__"; exit 1; fi; echo collect-ok
```

Confirm the paths really are in the config (negative-assertion inverted so clean exits 0):

```
for f in feedback-sweep watchdog-helpers watchdog-relaunch active-sessions; do
  if ! grep -q "scripts/__tests__/$f.test.cjs" vitest.config.ts; then echo "HALT: $f not registered in vitest.config.ts"; exit 1; fi
done; echo registered-ok
```

Confirm the stale PRD is out of the active dir:

```
if [ -f session-manager-operations/scheduler/prds/672-fix-feedback-session-manager.md ]; then echo "HALT: completed 672 PRD still live in prds/"; exit 1; fi; echo archived-ok
```

Full gate LAST:

```
timeout 600 npm run test:unit
```

# Acceptance criteria

- [ ] All four `scripts/__tests__/*.test.cjs` files are listed as explicit entries in
      `vitest.config.ts`'s `test.include` array (not via a glob).
- [ ] Each of the four files collects and passes under `npx vitest run <path>` with a non-zero
      test count — converted from `node:test` to vitest's injected globals only where required,
      with assertions and coverage unchanged.
- [ ] `session-manager-operations/scheduler/prds/672-fix-feedback-session-manager.md` is moved to
      `session-manager-operations/scheduler/prds-archived/` and the move is committed.
- [ ] `timeout 300 npm run typecheck` passes.
- [ ] `timeout 600 npm run test:unit` passes with the four new files included.
- [ ] Work is committed and `SCHEDULER_VERDICT: PASS` is the literal last line.

# Out of scope

- **Any change to `src/main/runVerify.cjs`'s `pass_no_commit` logic or to `resetJobFields` in
  `src/main/scheduler.cjs`** — that is queued PRD `817-verifier-exempt-already-landed-slug-reruns`.
  Touching it here creates a conflicting duplicate.
- Registering `src/main/__tests__/runVerify.test.cjs` with vitest — that is queued PRD
  `816-vitest-register-runverify-test`.
- Any change to `scripts/lib/watchdogHelpers.cjs` behaviour. The resolver and the
  `missing-inline` refusal already work; this PRD only makes their tests run in the standing gate.
- Re-running or re-authoring the feedback pass, and any change to the process-feedback or develop
  skill content.
- Registering the other ~30 unlisted `src/main/**/*.test.cjs` `node:test` files with vitest —
  a real gap, but a separate, much larger sweep.

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

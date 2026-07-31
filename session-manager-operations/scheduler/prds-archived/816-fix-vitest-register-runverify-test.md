---
title: "Fix: extend already-shipped verifier exemption to repo-root config deliverables"
cwd: /home/bilko/Projects/session-manager
parallelGroup: 816
estimateMinutes: 35
---

# Goal

Job `816-vitest-register-runverify-test` did NOT fail. It exited 0, verified all five of its
acceptance criteria live (48 tests green under `npx vitest run src/main/__tests__/runVerify.test.cjs`,
1398 tests via `npm run test:unit`, clean `npm run typecheck`), made no code change because none was
needed, and printed a truthful `SCHEDULER_VERDICT: PASS`. The post-run verifier
(`src/main/runVerify.cjs`) parked it anyway with:

```
verifierVerdict: pass_no_commit
error: "SCHEDULER_VERDICT: PASS but no commit landed during the run window —
        the run claims success but produced no code change"
status: needs_review
```

Close the remaining gap in the verifier's `pass_no_commit_already_shipped` exemption so this class of
truthful-no-op run auto-clears.

## Root-cause analysis

**Why there was nothing to do.** PRD 816's actual work — registering
`src/main/__tests__/runVerify.test.cjs` in `vitest.config.ts`'s `test.include` array and porting the
file from `node:test` to `import { test } from 'vitest'` — already landed in commit **29d75c3**
(`test(vitest): port runVerify.test.cjs onto the vitest runner`) at 2026-07-31 00:58 PDT, roughly
7h45m before the 08:44 run. `grep -n runVerify vitest.config.ts` now returns line 40. The executor
was correct; the PRD was stale by the time the scheduler picked it up.

**Why the verifier parked it anyway.** `src/main/runVerify.cjs` already carries an exemption for
exactly this case — `pass_no_commit_already_shipped` (`extractPrdDeliverablePaths` at line ~576,
`allDeliverablesAlreadyTracked` at line ~599, call site at line ~904). It materially checks, via
`git ls-files --error-unmatch`, whether every deliverable path the PRD body names is already tracked,
and if so treats a PASS-with-no-commit as truthful.

That exemption was folded in by **the same commit 29d75c3**. Running it live today against PRD 816's
body extracts `src/main/__tests__/runVerify.test.cjs`, finds it tracked, and returns `true` — i.e.
the exemption *would* fire. It did not fire at 08:44 because main-process `.cjs` modules are loaded
once at Electron app start: the running scheduler still held a **pre-29d75c3 in-memory copy** of
`runVerify.cjs`. The app had not been restarted since 00:58. That part is self-correcting on the next
app restart and needs no code change.

**The real remaining defect.** `PRD_DELIVERABLE_PATH_RE` (src/main/runVerify.cjs:567) is:

```js
const PRD_DELIVERABLE_PATH_RE = /(?:^|[`\s(])((?:src|scripts|session-manager-operations|test|tests|docs|bin)\/[A-Za-z0-9_./-]*[A-Za-z0-9_-]\.[A-Za-z0-9]+)\b/g;
```

It only matches paths under a source *directory*. **Repo-root config files are invisible to it** —
`vitest.config.ts`, `package.json`, `tsconfig.json`, `vite.config.ts`, `playwright.config.ts`,
`eslint.config.js`. PRD 816 named `vitest.config.ts` as its primary deliverable (the `test.include`
edit) and that path was silently dropped from extraction; only the incidental
`src/main/__tests__/runVerify.test.cjs` mention saved it. **A PRD whose ONLY deliverable is a
repo-root config file gets zero extracted paths, `allDeliverablesAlreadyTracked` returns `false`
(it early-returns on an empty array), and the run is parked as `pass_no_commit` even when the work
demonstrably already shipped.** That is the bug to fix.

# Fix steps

Work in `/home/bilko/Projects/session-manager`. All edits are in two files.

## Step 1 — read the current code first

```bash
timeout 30 sed -n '560,615p' src/main/runVerify.cjs
timeout 30 sed -n '885,925p' src/main/runVerify.cjs
timeout 30 grep -n "extractPrdDeliverablePaths" src/main/__tests__/runVerify.test.cjs
```

Note that `runVerify.test.cjs` is now a **vitest** file (`import { test } from 'vitest'`) and is
registered in `vitest.config.ts` line 40 — write new tests in that same style, not `node:test`.

## Step 2 — extend deliverable-path extraction to repo-root config files

In `src/main/runVerify.cjs`, add a second, explicitly-allowlisted pattern for repo-root config files
alongside `PRD_DELIVERABLE_PATH_RE`. Keep it narrow and deliberate — an allowlist of exact filenames,
NOT a general "any root file with an extension" rule (that would match prose like `README.md` or
`queue.json` and produce false exemptions):

```js
// Repo-root config files a PRD can legitimately name as its only deliverable.
// Deliberately an exact-name allowlist, not a general root-file pattern:
// a loose rule would match prose mentions (README.md, queue.json) and grant
// false exemptions. Incident: PRD 816 named vitest.config.ts as its primary
// deliverable and it was silently dropped from extraction.
const PRD_ROOT_CONFIG_DELIVERABLES = [
  'package.json',
  'tsconfig.json',
  'vitest.config.ts',
  'vite.config.ts',
  'playwright.config.ts',
  'eslint.config.js',
  'tailwind.config.js',
  'postcss.config.js',
];
```

Then in `extractPrdDeliverablePaths`, after the existing regex loop, append any allowlisted root
config filename that appears in the PRD body as a whole word (guard the match so `foo/package.json`
or `some-vite.config.ts` does not count — require the name to be preceded by a backtick, whitespace,
or start-of-string, and followed by a non-path character). Preserve the existing `seen` dedupe so a
name mentioned twice yields one entry. Keep the function O(n) over body length and keep its existing
guards (`node_modules`, `..`, non-string input → `[]`).

Do NOT change `allDeliverablesAlreadyTracked` — its `git ls-files --error-unmatch` check and
fail-safe-to-false behavior are correct as written and already handle multi-path input.

Do NOT change the call site's ordering (`!mergeMainVerified && !priorRunVerified` guard, the
`conclude('pass_no_commit_already_shipped', …)` return) — only extraction changes.

## Step 3 — add regression tests

In `src/main/__tests__/runVerify.test.cjs`, add tests (vitest style, matching the file's existing
imports and assertion idiom):

1. `extractPrdDeliverablePaths` returns `['vitest.config.ts', 'src/main/__tests__/runVerify.test.cjs']`
   (order per implementation; assert set membership if order is incidental) for a PRD body containing
   both a backticked `` `vitest.config.ts` `` mention and a backticked src path.
2. `extractPrdDeliverablePaths` returns `['vitest.config.ts']` for a body that names ONLY the root
   config — the exact PRD-816-shaped case that previously extracted nothing.
3. A negative case: a body mentioning `some/nested/package.json` or `README.md` does NOT yield a
   spurious root-config entry (`README.md` is not on the allowlist; the nested path must not be
   collapsed to bare `package.json`).
4. An end-to-end-ish case through the same seam the existing `pass_no_commit_already_shipped` tests
   use: with `allDeliverablesAlreadyTracked` given an injected `execImpl` that succeeds, a root-config-only
   PRD body yields the `pass_no_commit_already_shipped` verdict rather than `pass_no_commit`. Follow
   whatever harness the existing already-shipped tests in this file use — reuse it, do not build a
   second one.

## Step 4 — clear the stale job (no code change; do this only if it is a plain file edit)

Job `816-vitest-register-runverify-test` sits in `~/.claude/session-manager/scheduled-plans/queue.json`
with `status: needs_review`. The `scheduler_reset_job` MCP tool only works while the Electron app is
running, which a headless run cannot assume. **Do not attempt to start the app, and do not hand-edit
`queue.json`** — a concurrent scheduler tick owns that file and a racing write can corrupt the queue.
Leave the job as-is and note in your finish output that it needs a manual clear (or will clear on the
next reverify pass once the app restarts and picks up the fixed `runVerify.cjs`). This step is
informational only; it is not an acceptance criterion.

# Verification commands

Run these in order; the AC gate must be LAST and green:

```bash
timeout 60 npx vitest run src/main/__tests__/runVerify.test.cjs
timeout 300 npm run typecheck
timeout 60 npm run lint:selectors
timeout 300 npm run test:unit
```

# Acceptance criteria

- [ ] `src/main/runVerify.cjs` extracts repo-root config deliverables (at minimum `vitest.config.ts`,
      `package.json`, `tsconfig.json`) from a PRD body via an exact-name allowlist, in addition to the
      existing source-directory regex
- [ ] A PRD body naming ONLY a repo-root config file yields a non-empty
      `extractPrdDeliverablePaths` result (previously `[]`), so `allDeliverablesAlreadyTracked` can
      grant the `pass_no_commit_already_shipped` exemption
- [ ] A nested path (`some/nested/package.json`) or a non-allowlisted root file (`README.md`) does NOT
      produce a spurious root-config extraction
- [ ] New regression tests are added to `src/main/__tests__/runVerify.test.cjs` in **vitest** style
      (matching that file's current `import { test } from 'vitest'` idiom, not `node:test`), covering
      all three cases above plus the verdict-level `pass_no_commit_already_shipped` case
- [ ] `timeout 60 npx vitest run src/main/__tests__/runVerify.test.cjs` exits 0, all tests pass
- [ ] `timeout 300 npm run test:unit` exits 0
- [ ] `timeout 300 npm run typecheck` exits 0
- [ ] `timeout 60 npm run lint:selectors` exits 0
- [ ] The change is committed and `SCHEDULER_VERDICT: PASS` is the literal last line

# Out of scope

- Do NOT modify `vitest.config.ts` or `src/main/__tests__/runVerify.test.cjs`'s existing tests —
  PRD 816's original work already landed in commit 29d75c3 and is green. Only ADD tests.
- Do NOT change `allDeliverablesAlreadyTracked`'s git-check logic or its fail-safe-to-false behavior.
- Do NOT change the `pass_no_commit` / `pass_no_commit_already_shipped` call-site ordering or the
  `mergeMainVerified` / `priorRunVerified` guards.
- Do NOT hand-edit `~/.claude/session-manager/scheduled-plans/queue.json` or try to launch the
  Electron app to reset the job.
- Do NOT broaden the root-config match into a general "any root file with an extension" pattern.

## Engineering standards

The following is inlined verbatim from
`/home/bilko/Projects/session-manager/plugins/session-manager-dev/skills/develop/standards.md`.

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

---
title: Fix: isolate scheduler-find-prd-dir test from the live PRD dir and retire vanished-source jobs
cwd: /home/bilko/Projects/session-manager
parallelGroup: 812
estimateMinutes: 50
---

# Goal

Stop `npm run test:unit` from injecting a phantom job into the live scheduler queue, and
make the scheduler treat a PRD source that disappeared between enqueue and dispatch as a
stale-row retirement instead of a hard `exitCode: -1` failure.

This is a fix-plan PRD for failed job `812-test-legacy-only-1975929-233060`.

## Root-cause analysis

The failed job was never a real PRD. It was a **unit-test fixture that leaked into the live
scheduler**, and the run died before any agent was spawned. The entire failure log is:

```
[scheduler] starting 812-test-legacy-only-1975929-233060 at 2026-08-02T13:47:58.348Z
[scheduler] cwd=/home/bilko/Projects/session-manager

[scheduler] failed to read PRD: ENOENT: no such file or directory, open '/home/bilko/Projects/session-manager/session-manager-operations/scheduler/prds/812-test-legacy-only-1975929-233060.md'
```

The chain:

1. `src/main/__tests__/scheduler-find-prd-dir.test.cjs:24-36` writes a **real file** into the
   **real, live** `PRDS_DIR`:

   ```js
   const slug = `812-test-legacy-only-${process.pid}-${Math.floor(Math.random() * 1e6)}`;
   const legacyPath = path.join(PRDS_DIR, `${slug}.md`);
   fs.mkdirSync(PRDS_DIR, { recursive: true });
   fs.writeFileSync(legacyPath, '---\ntitle: legacy fixture\n---\n\n# Goal\n\ntest\n', 'utf8');
   ```

   The slug `812-test-legacy-only-1975929-233060` is exactly `812-test-legacy-only-<pid>-<rand>`,
   and the failed job's title (`legacy fixture`) and body (`# Goal\n\ntest`) match the fixture
   byte-for-byte. This is conclusive.

2. `PRDS_DIR` is **not** a temp dir. `src/main/scheduler.cjs:351-352`:

   ```js
   const ROOT = path.join(os.homedir(), '.claude', 'session-manager', 'scheduled-plans');
   const PRDS_DIR = path.join(ROOT, 'prds');
   ```

   The test file's own header comment acknowledges it "touches the real legacy PRDS_DIR" — that
   was accepted as harmless, but it is not: `candidatePrdsDirs()` (`scheduler.cjs:485-487`) returns
   `[PRDS_DIR, ...resolvePrdsDirs()]`, so the live scheduler's `reconcile()` scans that directory
   every 60 s.

3. `reconcile()` saw an unmatched on-disk PRD and enqueued it. The Epic-approval gate
   (`scheduler.cjs:~1238`, `if (p.epicId && ownerStatus === 'proposed') continue;`) did **not**
   stop it, correctly: the fixture lives in the flat legacy dir, so `deriveEpicIdFromPrdPath`
   yields no `epicId` and there is nothing to gate on. The fixture also has no `cwd:` in its
   frontmatter, so the job inherited `DEFAULT_PROJECT_CWD` = `/home/bilko/Projects/session-manager`.

4. The test's `finally` block then `rmSync`'d the fixture — milliseconds later, but the queue row
   was already durable.

5. At dispatch, `executeJob` (`scheduler.cjs:2013-2049`) resolved `prdPathForJob(job)` to the
   job-cwd-scoped `<cwd>/session-manager-operations/scheduler/prds/<slug>.md` (which never existed),
   `findPrdDir(job.slug)` returned `null` (file deleted), and `archivedTwinExists(job)` was false
   (never archived). So it took the hard-failure branch: `safeLog('failed to read PRD: ...')`,
   `return { exitCode: -1, ... }`.

So there are **two** defects, and both should be fixed:

- **Primary (cause):** a unit test mutates live production state. Any developer running
  `npm run test:unit` while the app is running injects a phantom job, burns a scheduler slot,
  and generates a spurious RCA feedback item.
- **Secondary (blast radius):** "PRD source existed at enqueue, gone at dispatch" is classified as
  a hard `exitCode: -1` failure. That is the wrong classification — a deleted source means the row
  is stale, not that the work failed. `archivedTwinExists` already handles the *archived* variant of
  this exact race via `prdArchivedSkipResult`; the *deleted* variant has no equivalent.

**Also leaked by test isolation gaps** — a stray nested directory exists in this repo:

```
session-manager-operations/scheduler/session-manager-operations/scheduler/state/queue.json
```

i.e. a doubled `session-manager-operations/scheduler` path join, containing `{"jobs": []}`. Some
test used the repo's own `scheduler/` dir as a fake project `cwd`. Clean it up and find the writer.

## Fix steps

### Step 1 — isolate `scheduler-find-prd-dir.test.cjs` from the live scheduler root

`scheduler.cjs` derives `ROOT` from `os.homedir()` at module load. On Linux `os.homedir()` reads
`process.env.HOME`. So the test must set `HOME` to a temp dir **before** `scheduler.cjs` is first
loaded, and load it dynamically.

Rewrite `src/main/__tests__/scheduler-find-prd-dir.test.cjs` along these lines (adapt to the file's
actual import style — it currently mixes `import { test, expect } from 'vitest'` with `require`):

```js
import { test, expect, beforeAll, afterAll } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let tmpHome;
let findPrdDir;
let PRDS_DIR;

beforeAll(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-find-prd-dir-'));
  process.env.HOME = tmpHome;
  // Load AFTER HOME is stubbed — scheduler.cjs snapshots os.homedir() at module load.
  ({ findPrdDir, PRDS_DIR } = require('../scheduler.cjs'));
  // Hard guard: never let this test write into the real scheduler root.
  if (!PRDS_DIR.startsWith(tmpHome)) {
    throw new Error(`refusing to run: PRDS_DIR (${PRDS_DIR}) is not under the temp HOME (${tmpHome})`);
  }
});

afterAll(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
});
```

Requirements for this step:

- Save and restore the original `process.env.HOME` (capture in `beforeAll`, restore in `afterAll`)
  so other specs in the same worker are unaffected.
- Keep the **guard assertion** — `PRDS_DIR` must resolve under the temp HOME, else throw. That guard
  is the actual regression test for this incident: if module-load ordering ever regresses so the
  real homedir is snapshotted first, the test fails loudly instead of silently poisoning the queue.
- If `scheduler.cjs` turns out to be already-loaded in the same worker by another spec (module cache
  makes the HOME stub ineffective), fall back to `vi.resetModules()` before the `require`, and if
  that still isn't enough, run this spec in an isolated vitest environment
  (`// @vitest-environment node` + a `test.concurrent`-free file, or vitest `poolOptions` isolation).
  Verify empirically with the guard rather than assuming.
- Both existing assertions must still pass unchanged in meaning: a slug present only in the legacy
  `PRDS_DIR` resolves to `PRDS_DIR`; a slug present nowhere resolves to `null`.

### Step 2 — sweep for other tests that write into live scheduler state

Run:

```
timeout 120 grep -rn "PRDS_DIR\|scheduled-plans\|session-manager-operations" src/main/__tests__ src/renderer --include=*.test.* --include=*.spec.* | grep -v node_modules
```

For every hit that **writes** (not just reads) into a path derived from the real `os.homedir()` or
the real repo cwd, either redirect it to a temp dir the same way, or document in a one-line comment
why it is read-only. Do not silently leave a second live-writing test in place — this incident class
recurs. Report in your finish output which files you inspected and which you changed.

### Step 3 — remove the leaked nested directory and find its writer

```
timeout 60 git -C /home/bilko/Projects/session-manager status --short session-manager-operations/scheduler
timeout 60 ls -R session-manager-operations/scheduler/session-manager-operations
```

- If the nested `session-manager-operations/scheduler/session-manager-operations/` tree is untracked
  and contains only `scheduler/state/queue.json` with `{"jobs": []}` (verify before deleting), remove
  it: `rm -rf session-manager-operations/scheduler/session-manager-operations`.
- If it **is** git-tracked, `git rm -r` it in your commit.
- Then locate the writer: grep the test suite for a fixture cwd of
  `session-manager-operations/scheduler` (or any test passing a path that already ends in
  `session-manager-operations/...` into `resolvePrdWriteDir`/`queueStore.writeSplit`, both of which
  append `session-manager-operations/scheduler/...` themselves). Fix that test to use a `mkdtemp`
  cwd. If you cannot find the writer within a reasonable search, still delete the directory and say
  explicitly in your finish output that the writer was not identified.

### Step 4 — retire, don't fail, a job whose PRD source vanished

In `src/main/scheduler.cjs`, `executeJob`'s PRD-read failure handling (around lines 2013-2049):

- Today both failure branches call `archivedTwinExists(job)` and, if false, return
  `{ exitCode: -1, error }`.
- Add a sibling check for the *deleted* case. Concretely: when the read error is `ENOENT` **and**
  `findPrdDir(job.slug)` returned `null` **and** `archivedTwinExists(job)` is false, treat the row
  as stale rather than failed.
- Implement this by generalizing `prdArchivedSkipResult` (`scheduler.cjs:573-584`) — do **not**
  copy-paste a second near-identical function. Suggested shape: add a `reason` parameter so it can
  emit either `skipped: 'prd-archived'` (existing message, unchanged) or a new
  `skipped: 'prd-missing'` with a message like
  `PRD source no longer exists on disk — retiring stale queue entry`.
  Keep `exitCode: 0` so it does not generate an RCA feedback item.
- Keep the existing behaviour for **non-ENOENT** read errors (a malformed/unreadable PRD is a real
  failure and must still return `exitCode: -1`). Do not widen the skip to every parse error.
- Update the block comments above those branches so the three cases (found-elsewhere / archived /
  deleted) are documented in one place.

### Step 5 — add a regression unit test for Step 4

Add a focused test (new file, e.g. `src/main/__tests__/scheduler-prd-missing-skip.test.cjs`, or
extend an existing `executeJob`-level scheduler spec if one already exercises this branch — check
first with `ls src/main/__tests__ | grep -i sched`).

It must assert:

- A job whose PRD source is absent everywhere (no live dir, no archive) yields
  `exitCode: 0` with `skipped: 'prd-missing'`, **not** `exitCode: -1`.
- A job whose PRD source is present but unparseable/unreadable for a non-ENOENT reason still yields
  `exitCode: -1`.

This test must itself follow Step 1's isolation rule — temp HOME, temp cwd, no writes into the real
scheduler root. Add the same `PRDS_DIR.startsWith(tmpHome)` guard.

### Step 6 — clean up the stale queue row and run artifacts (best effort)

The queue is currently empty (`session-manager-operations/scheduler/state/queue.json` → `{"jobs": []}`),
so no live row needs retiring. Verify this is still true before you finish:

```
timeout 30 node -e "const q=require('/home/bilko/Projects/session-manager/session-manager-operations/scheduler/state/queue.json'); const hit=q.jobs.filter(j=>String(j.slug).includes('test-legacy-only')); console.log('leaked rows:', hit.length); if(hit.length) console.log(JSON.stringify(hit,null,2));"
```

If any `test-legacy-only` row is present, do **not** hand-edit `queue.json` while the app may be
running — report it in your finish output and leave it. Do not launch a second Electron instance to
fix it (that SIGTERMs live scheduler jobs).

## Verification

Run all of these. Each must be bounded by a hard timeout.

```
timeout 300 npm run typecheck
timeout 120 npx vitest run src/main/__tests__/scheduler-find-prd-dir.test.cjs
timeout 120 npx vitest run src/main/__tests__/scheduler-prd-missing-skip.test.cjs
timeout 600 npm run test:unit
timeout 120 npm run lint:selectors
```

Then prove the leak is gone. Snapshot the live PRD dir, run the full unit suite, and diff — this is
a **negative-assertion check**, so it must exit 0 when clean:

```
timeout 60 bash -c '
  D="$HOME/.claude/session-manager/scheduled-plans/prds"
  mkdir -p "$D"
  before=$(ls -1 "$D" | sort)
  timeout 600 npm run test:unit >/dev/null 2>&1 || { echo "HALT: unit suite failed"; exit 1; }
  after=$(ls -1 "$D" | sort)
  if [ "$before" != "$after" ]; then
    echo "HALT: unit suite mutated the live PRDs dir"
    diff <(echo "$before") <(echo "$after") || true
    exit 1
  fi
  echo "clean: live PRDs dir untouched by unit suite"
'
```

And confirm the nested dir is gone (negative assertion, inverted so clean = exit 0):

```
timeout 30 bash -c 'if [ -e /home/bilko/Projects/session-manager/session-manager-operations/scheduler/session-manager-operations ]; then echo "HALT: nested leak dir still present"; exit 1; fi; echo clean'
```

Order the run so the **last** command is a green gate — put the full `npm run test:unit` /
`npm run typecheck` pass last, after the negative-assertion checks.

## Acceptance criteria

1. `src/main/__tests__/scheduler-find-prd-dir.test.cjs` writes **no** file under the real
   `~/.claude/session-manager/scheduled-plans/`; it uses a `mkdtemp` HOME and asserts
   `PRDS_DIR.startsWith(tmpHome)` before doing anything else. Both of its original assertions still
   pass.
2. `process.env.HOME` is saved and restored, so no sibling spec is affected.
3. Step 2's sweep is done and reported: every test that writes into live scheduler state is either
   fixed or explicitly justified in a comment.
4. The nested `session-manager-operations/scheduler/session-manager-operations/` directory no longer
   exists in the repo (removed from disk, and from git if it was tracked).
5. `executeJob` returns `exitCode: 0` with `skipped: 'prd-missing'` when a queued job's PRD source
   has been deleted (ENOENT everywhere, no archived twin) — no longer `exitCode: -1`. Non-ENOENT
   PRD read/parse failures still return `exitCode: -1`.
6. The skip logic reuses a single generalized `prdArchivedSkipResult`; there is no duplicated
   near-identical helper.
7. A regression test covers both branches of criterion 5 and is itself HOME-isolated.
8. `timeout 300 npm run typecheck`, `timeout 600 npm run test:unit`, and
   `timeout 120 npm run lint:selectors` all pass.
9. The before/after `ls` diff of the live PRDs dir across a full unit-suite run is empty.
10. Work is committed and `SCHEDULER_VERDICT: PASS` is the literal last line.

## Notes for the executor

- This PRD file was written into the retired flat `session-manager-operations/scheduler/prds/` dir
  because the RCA tooling specifies that exact path. That dir is auto-consolidated into
  `prds-archived/` at app boot. If you are reading this, it was picked up in time — just be aware
  the file may already have moved; don't be alarmed if it isn't where you expect at the end.
- Do **not** launch a second Electron instance to check anything. It SIGTERMs live scheduler jobs
  and clobbers `admin-api.json`.
- Do **not** queue session-manager's own e2e suite as part of this work.
- The failed job under investigation was not a self-delegation failure and not a code defect in the
  PRD it was "running" — there was no real PRD. Do not go looking for a bug in job 812's business
  logic; the bug is entirely in test isolation plus failure classification.

## Engineering standards

The following section is inlined verbatim from
`plugins/session-manager-dev/skills/develop/standards.md`.

### Execution discipline (headless runs)

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

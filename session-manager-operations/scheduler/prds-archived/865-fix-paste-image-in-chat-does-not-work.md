---
title: "Fix: make prdPathForJob/archivedTwinExists Epic-aware so an archived Epic PRD skips instead of exit -1"
cwd: /home/bilko/Projects/session-manager
parallelGroup: 865
estimateMinutes: 45
---

# Goal

Scheduler job `865-paste-image-in-chat-does-not-work` failed with exit code `-1` **without
running any of its work**. The entire failure log was:

```
[scheduler] starting 865-paste-image-in-chat-does-not-work at 2026-08-01T06:19:54.840Z
[scheduler] cwd=/home/bilko/Projects/session-manager
[scheduler] failed to read PRD: ENOENT: no such file or directory, open
  '/home/bilko/Projects/session-manager/session-manager-operations/scheduler/prds/865-paste-image-in-chat-does-not-work.md'
```

This PRD does **not** implement paste-image-in-chat. It fixes the *scheduler path-resolution
bug* that made the job unrunnable. The original 865 PRD body is preserved at
`session-manager-operations/scheduler/epics/psess-ms9yi6hy-14/prds-archived/865-paste-image-in-chat-does-not-work.md`
and can be re-queued by a human after this lands.

# Root-cause analysis

All line numbers are in `src/main/scheduler.cjs` (verify them — the file changes often; find
the functions by name, not by line).

**Timeline (America/Los_Angeles):**

1. `22:54` — PRD 865 was authored into the **Epic-scoped** dir
   `session-manager-operations/scheduler/epics/psess-ms9yi6hy-14/prds/865-paste-image-in-chat-does-not-work.md`.
   This is the correct, current write layout (CLAUDE.md domain model: every new PRD is
   Epic-scoped; the flat `scheduler/prds/` dir is RETIRED and read-only).
2. `23:14` — the `.md` was archived by `archiveCompletedPrd(slug, cwd)` into that Epic's
   **sibling** archive dir: `epics/psess-ms9yi6hy-14/prds-archived/865-*.md`.
   `archiveCompletedPrd` computes `path.join(srcDir, '..', 'prds-archived')` where `srcDir`
   came from `findPrdDir(slug)` — so for an Epic PRD the archive lands *inside the Epic dir*.
3. `23:19` — the still-pending queue row fired. `executeJob` tried to read the PRD and hit
   ENOENT, then failed the job outright with exit `-1`.

**Two Epic-blind helpers are the defect:**

- **`prdPathForJob(job)`** returns
  `path.join(prdDirForCwd(job.cwd), job.slug + '.md')`, and `prdDirForCwd` is
  `resolvePrdWriteDir(cwd)` — the **retired flat** `<cwd>/session-manager-operations/scheduler/prds/`.
  That is literally the path in the ENOENT message. The first read attempt therefore always
  probes a directory that, by design, no longer holds any live PRD.
  There *is* a fallback in `executeJob` — `findPrdDir(job.slug)`, which walks
  `candidatePrdsDirs()` and **does** include every `epics/<id>/prds` dir — so a *live* Epic
  PRD is still found. It only fails when the file has already left `prds/`.

- **`archivedPrdPathForJob(job)` / `archivedTwinExists(job)`** check **only**
  `path.join(prdDirForCwd(job.cwd), '..', 'prds-archived', slug + '.md')` — i.e. the **flat**
  `scheduler/prds-archived/`. The real twin was in `epics/psess-ms9yi6hy-14/prds-archived/`,
  so the guard returned `false`, the benign
  `prdArchivedSkipResult(...)` path (which returns `exitCode: 0, skipped: 'prd-archived'`)
  never fired, and both PRD-read failure branches fell through to
  `safeLog('[scheduler] failed to read PRD: ...')` + `exitCode: -1`.

**Why this is systemic, not a one-off:** every new PRD is Epic-scoped, and
`archiveCompletedPrd` archives into the *Epic's* sibling `prds-archived/`. So the
archived-twin stale-skip guard — added specifically to stop exactly this class of false
failure (see the header of `src/main/__tests__/scheduler-archived-twin-guard.test.cjs`,
"PRD 822 recurrence fix") — **can never match for any modern PRD**. Any PRD that gets
archived while its queue row is still pending will hard-fail with exit `-1` and spawn a
bogus RCA feedback item, forever, until this is fixed.

Note: `allocateParallelGroup` in the same file already demonstrates the correct Epic-aware
pattern — it composes `listEpicPrdDirs(targetCwd)` with the flat `prds-archived` dir. Reuse
that idea rather than inventing a parallel scheme (`## Engineering standards` → API reuse).

# Fix steps

Work in `/home/bilko/Projects/session-manager`. Write the failing tests first (TDD, see
standards below), then the implementation.

### 1. Add an Epic-aware archive-dir enumerator (single source of truth)

In `src/main/lib/prdLocations.cjs`, next to the existing `listEpicPrdDirs(cwd)`, add and
export:

```js
/**
 * Every `prds-archived/` dir for one project cwd: the retired flat layout's
 * sibling archive plus each Epic's own sibling archive. Consumed by the
 * scheduler's archived-twin stale-queue-row guard.
 */
function listArchivedPrdDirs(cwd) { /* flat: <cwd>/session-manager-operations/scheduler/prds-archived
                                       epic: <epicsRoot>/<id>/prds-archived (only those that exist) */ }
```

Mirror `listEpicPrdDirs`'s existing defensive style exactly: `try`/`catch` around
`resolveEpicsRoot`, `try`/`catch` around `fs.readdirSync`, return `[]` on any failure, and
only include dirs that `fs.existsSync`. **Always include the flat archive dir
unconditionally** (path join, no I/O) so it stays first in the list — callers must keep
finding legacy archived twins. Export it from `module.exports` alongside `listEpicPrdDirs`.

### 2. Make `archivedTwinExists` search every archive dir

In `src/main/scheduler.cjs`:

- Import `listArchivedPrdDirs` from `./lib/prdLocations.cjs` (join the existing
  `require` of that module — do not add a second require).
- Change **`archivedPrdPathForJob(job)`** to *resolve* rather than blindly join: return the
  first `path.join(dir, slug + '.md')` across `listArchivedPrdDirs(job.cwd)` that exists on
  disk, falling back to the flat path (current behaviour) when none exists. The fallback
  matters: `prdArchivedSkipResult` uses this path only for a log/note string, and the
  existing test `archivedPrdPathForJob resolves to the sibling prds-archived/<slug>.md for a
  job cwd` asserts the flat path for a cwd with no files on disk — **that test must keep
  passing unchanged**.
- Change **`archivedTwinExists(job)`** to return `true` if a `<slug>.md` exists in **any**
  dir returned by `listArchivedPrdDirs(job.cwd)`.
- Preserve the path-traversal guard: the existing test
  `archivedPrdPathForJob does not escape prds-archived/ for a well-formed slug` must still
  pass. Do not let a slug containing `/` or `..` escape the archive dir — reuse the existing
  `safeSlugPathIn(dir, slug)` helper already in `scheduler.cjs` for the join if it fits, and
  skip any candidate it rejects.

### 3. Make the *first* PRD read attempt Epic-aware (removes the misleading ENOENT)

Still in `src/main/scheduler.cjs`, in `executeJob`'s "Read full PRD body fresh from disk"
block: before falling back, resolve the live PRD through `findPrdDir(job.slug)` semantics
rather than probing the retired flat dir first. Minimal correct change: keep
`prdPathForJob(job)` as-is (other callers depend on it as a pure path join), but at the read
site prefer a resolved path:

```js
const foundDir = await findPrdDir(job.slug);
let prdPath = foundDir ? path.join(foundDir, `${job.slug}.md`) : prdPathForJob(job);
```

…then keep the existing `try`/`catch` + archived-twin guard exactly as it is. This makes the
common Epic-PRD case a first-try hit and stops the log from naming a retired directory. Do
**not** change `prdPathForJob`'s signature or return type — it is exported and used by
several other call sites (`:1697`, `:2342`, `:2563`, `:3455`).

### 4. Tests (write these FIRST — they must be red before step 1-3, green after)

Extend `src/main/__tests__/scheduler-archived-twin-guard.test.cjs` (do not create a new
file — it already owns this behaviour and has the temp-cwd fixture helper `makeFixtureCwd`):

- `archivedTwinExists returns true when the twin lives in an EPIC's prds-archived dir` —
  build `<cwd>/session-manager-operations/scheduler/epics/psess-fixture-1/prds-archived/<slug>.md`,
  assert `archivedTwinExists({ slug, cwd })` resolves `true`. **This is the regression test
  for job 865 and must fail on current `main`.**
- `archivedTwinExists still returns true for a flat-layout twin` — keep the existing flat
  case passing.
- `archivedTwinExists returns false when no twin exists in any layout`.
- Add a unit test for `listArchivedPrdDirs` in the same file (or in
  `src/main/__tests__/` next to the other prdLocations tests if one exists — check with
  `ls src/main/__tests__ | grep -i prdloc` first and follow whatever convention is there):
  asserts it returns the flat dir plus every existing Epic archive dir, and does not throw
  on a cwd with no `session-manager-operations/` at all.

All tests use temp dirs via `fs.mkdtempSync` — **never touch the real
`~/.claude/session-manager/` tree or this repo's own `session-manager-operations/`.**

### 5. Do NOT re-queue PRD 865's original work

Leave `epics/psess-ms9yi6hy-14/prds-archived/865-paste-image-in-chat-does-not-work.md` where
it is. Re-queuing the paste-image feature is a human decision and is explicitly **out of
scope** for this run.

# Verification

Run these, in this order, and let the AC gate be the last command:

```bash
cd /home/bilko/Projects/session-manager
timeout 300 npx vitest run src/main/__tests__/scheduler-archived-twin-guard.test.cjs
timeout 300 npm run typecheck
timeout 120 npm run lint:selectors
timeout 300 npm run test:unit
```

Manual sanity check that the specific 865 shape now resolves (negative-assertion-shaped —
note the inversion so the clean case exits 0):

```bash
cd /home/bilko/Projects/session-manager
node -e '
const { archivedTwinExists } = require("./src/main/scheduler.cjs");
archivedTwinExists({ slug: "865-paste-image-in-chat-does-not-work", cwd: process.cwd() })
  .then((ok) => { if (!ok) { console.log("HALT: epic-scoped archived twin still not detected"); process.exit(1); }
                  console.log("OK: archived twin detected in epic prds-archived"); });
'
```

# Acceptance criteria

- [ ] `listArchivedPrdDirs(cwd)` exists and is exported from `src/main/lib/prdLocations.cjs`,
      returning the flat `scheduler/prds-archived` dir plus every existing
      `epics/<id>/prds-archived` dir, and returning a sane value (never throwing) for a cwd
      with no `session-manager-operations/`.
- [ ] `archivedTwinExists` in `src/main/scheduler.cjs` returns `true` for a twin in an
      **Epic's** `prds-archived/`, and still `true` for a flat-layout twin.
- [ ] A new regression test in `src/main/__tests__/scheduler-archived-twin-guard.test.cjs`
      covers the Epic-scoped twin case and fails on the pre-fix code.
- [ ] `executeJob`'s PRD read resolves the live PRD through the full candidate-dir search
      before failing, so the ENOENT log no longer names the retired flat `scheduler/prds/`
      dir for an Epic-scoped PRD.
- [ ] The two pre-existing `archivedPrdPathForJob` tests (flat-path resolution and the
      no-escape traversal guard) still pass unchanged.
- [ ] `timeout 300 npx vitest run src/main/__tests__/scheduler-archived-twin-guard.test.cjs` passes.
- [ ] `timeout 300 npm run typecheck` passes.
- [ ] `timeout 120 npm run lint:selectors` passes.
- [ ] `timeout 300 npm run test:unit` passes.
- [ ] The archived original PRD at
      `epics/psess-ms9yi6hy-14/prds-archived/865-paste-image-in-chat-does-not-work.md`
      is left untouched and no new PRD is queued by this run.

# Out of scope

- Implementing paste-image-in-chat (the original 865 goal). A human re-queues that.
- Changing `archiveCompletedPrd`'s destination, the flat-dir consolidation in
  `src/main/lib/prdMigration.cjs`, or any queue-reconciliation behaviour beyond the two
  helpers named above.
- Changing `prdPathForJob`'s signature or making it do I/O.

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

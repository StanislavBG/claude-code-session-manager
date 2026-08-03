---
title: "Fix: implement transcript paged reads (prior run self-aborted on seeing its own queue row)"
cwd: /home/bilko/Projects/session-manager
parallelGroup: 979
estimateMinutes: 40
---

# READ THIS FIRST — why this PRD exists

The canonical rule from `plugins/session-manager-dev/skills/develop/standards.md`, quoted verbatim:

> **You ARE the executor — never re-queue or self-schedule.** A headless PRD run must perform its own acceptance criteria directly.

**You are the executor. A queued PRD is the task, not evidence that the task is already handled.
The deliverable of this run is a code diff plus green tests, committed.**

The previous attempt at this work (run `2026-08-03T05-02-12-093Z`, slug
`979-transcript-paged-reads`) exited 0 in 51 seconds having written no code. What it did:

1. It ran `python3` over `session-manager-operations/scheduler/state/queue.json`.
2. It found the row `{"slug": "979-transcript-paged-reads", "status": "running", "runtime": {"pid": 3081964, ...}}`.
3. It concluded *"PRD 979 is already running right now as a live scheduler job… I'm not going to
   duplicate the work — a second implementation racing on `src/main/transcripts.cjs` against the
   running job would conflict"*, and ended the turn with prose telling the user to check the
   Scheduler tab.
4. No diff, no tests, no commit, no `SCHEDULER_VERDICT` sentinel. Exit 0.

**That "already running" row WAS its own job.** `scheduler.cjs` marks a job `running` — writing
its `runId`, `startedAt`, `sessionId` and the spawned `pid` into `queue.json` — *before* the
`claude -p` process it launched reaches the prompt. So the executor of PRD N will *always* see
PRD N as `running` if it looks. Seeing your own slug in `queue.json` with `status: "running"` is
**expected and means nothing except that you are the one running it.**

## Hard rules for this run

- **Do not read `session-manager-operations/scheduler/state/queue.json` or `history.jsonl` at
  all.** They are irrelevant to this task. There is no scenario in this PRD where queue state
  changes what you implement.
- **Do not treat any queue/scheduler/PID observation as grounds to skip work.** If you somehow
  believe the work is already done, prove it from the *source tree*: `git log --oneline -20`
  and reading `src/main/transcripts.cjs`. Absence of the code is the only valid evidence; a
  queue row is not.
- **Do not** invoke `/develop`, `session-manager-dev:develop`, `process-feedback`, or any
  queue-authoring skill. Do not call `ScheduleWakeup`. Do not end the turn saying you'll wait
  for anything — there is no next turn.
- **Do not** write a new PRD file. Implement the code.
- If you end this run without having modified `src/main/transcripts.cjs`, the run has failed.
  Emit `SCHEDULER_VERDICT: FAIL <reason>` and `exit 1` rather than a hollow PASS.

# Goal

`src/main/transcripts.cjs` destroys transcript history in two places:

- **Ring cap**: inside `doFlush`, `sub.buffer.push(ev); if (sub.buffer.length > 500) sub.buffer.shift();`
  (around line 138–142) — only the last 500 events of any session survive in memory.
- **Seek-to-tail**: `MAX_DELTA_BYTES = 8 * 1024 * 1024` (line 48); in `readDelta`, when
  `length > MAX_DELTA_BYTES`, it sets `readFrom = stat.size - MAX_DELTA_BYTES` (line ~87) and
  discards every byte before that on first attach to a large transcript.

Both silently hide history on any long-running Epic, contradicting the Simplified Chat promise
that nothing is hidden. Replace the in-memory event buffer with an **indexed, line-offset-based
paged read** over the transcript file, so the Chat view can scroll back to the genuine first
event of a session without ever holding the whole file in RAM.

# Acceptance criteria

- [ ] Read `src/main/transcripts.cjs` in full first — especially `readDelta()`: the inode-change
      reset, the `stat.size < sub.offset` truncation reset, and the `MAX_DELTA_BYTES`
      seek-to-tail branch with its deliberate `readFrom - 1` partial-line boundary handling.
- [ ] CORE: build a **line-offset index** per subscribed transcript (byte offset + byte length
      per JSONL line), maintained incrementally as `readDelta` consumes new bytes. The index —
      not the parsed events — is what persists in memory.
- [ ] CORE: a paging API returns events for an arbitrary `[startLine, endLine]` window by
      reading only those byte ranges from disk. Scrolling to the top of a session with more than
      500 events returns the genuine first event, not a truncated window. The `> 500`
      `sub.buffer.shift()` cap is gone.
- [ ] CORE (RISK — state this explicitly in a code comment): the `MAX_DELTA_BYTES` seek-to-tail
      exists because materializing a several-hundred-MB transcript into a Buffer plus a decoded
      string OOM-killed the main process. Paging MUST be an indexed positional read
      (`fd.read` with explicit offset/length) and MUST NEVER read the whole file into memory,
      not even transiently, and never via `fs.readFile`.
- [ ] TESTS/BOUNDS: add a unit test asserting bounded memory — indexing a synthetic transcript
      with a very large number of lines (and at least one multi-MB single line) keeps resident
      event/index memory under an explicit, asserted numeric ceiling. A real `expect(...)` bound,
      not a comment.
- [ ] EDGE: inode-change rotation and file truncation invalidate the index and rebuild it; a
      rotated transcript mid-session never serves stale or misaligned offsets. Test both.
- [ ] EDGE: a partial trailing line (a JSONL line still being written) is never indexed as
      complete and is picked up correctly on the next flush — preserve `readDelta`'s existing
      `sub.pending` semantics.
- [ ] EDGE: a malformed/unparseable JSON line is skipped for rendering but still occupies its
      index slot, so line numbering and offsets stay correct.
- [ ] INTERACTION EFFECT: the LRU pool (`LRU_CAP = 6` released subs, `MAX_TRANSCRIPT_SUBS = 20`)
      currently preserves `sub.buffer` across a release/re-subscribe so a tab switch resumes
      from the persisted offset rather than re-reading from byte 0. Preserve that fast-resume
      property with the index in place of the buffer, and test it.
- [ ] INTERACTION EFFECT: the initial-drain path emits to OTEL via `otel.recordTranscriptEvent`
      for backfilled transcripts. Confirm paging does not re-emit already-recorded events on
      every page request.
- [ ] `timeout 300 npm run typecheck`, `timeout 600 npm run test:unit`, and
      `timeout 300 npm run health` all pass.
- [ ] `timeout 60 npm run lint:selectors` passes (cheap, and this touches main→renderer data flow).
- [ ] The diff is **committed** during this run, and the run ends with a truthful
      `SCHEDULER_VERDICT: PASS` as the literal last line.

# Implementation notes

- Primary file: `src/main/transcripts.cjs` (401 lines). Existing constants, quoted so you need
  not grep: `MAX_DELTA_BYTES = 8 * 1024 * 1024`; `LRU_CAP = 6`; `MAX_TRANSCRIPT_SUBS = 20`; the
  ring cap is a bare `if (sub.buffer.length > 500) sub.buffer.shift()` inside `doFlush`.
- `readDelta` already opens an fd and does a positional `fd.read(buf, 0, length, readFrom)` —
  that is exactly the primitive paging needs. Extend that pattern; do **not** introduce a new
  stream/readline dependency.
- Dependency context: PRD `transcript-classifier-multi-emit` (commit `07202b4`,
  "fix(transcripts): classifyLine emits an array of events per line, not one") has landed. Read
  its diff (`git show 07202b4`) and `src/main/lib/classifyTranscriptLine.cjs` first. If it
  already threads a per-line byte reference (`{ filePath, byteOffset, byteLength }`) for the
  expand-to-full-text path, **reuse that** rather than computing offsets a second time — if the
  two representations diverge, consolidate to one. CLAUDE.md's API-reuse / single-source-of-truth
  rule applies.
- `scheduleFlush`'s dirty-flag trailing-edge re-run guarantees no event is dropped when chokidar
  fires mid-flush. Keep that invariant — index maintenance happens **inside** the serialized
  flush, never in a parallel path.
- Expose paging over the existing IPC surface (`transcript:*` handlers registered around
  line 371–384). Validate any renderer-supplied line range at the main-process boundary via a
  zod schema in `src/main/ipcSchemas.cjs` — follow that pattern, do not hand-roll validation.
  All paths still go through `config.cjs`'s `validatePath` allowedRoots discipline.
- Tests live under the repo's vitest setup; run a single file with
  `timeout 120 npx vitest run <path>`.
- TDD: write the failing test first (a transcript with >500 events whose first event is not
  retrievable today), then the implementation.

# Out of scope

- Renderer-side virtualized scrolling UI — this PRD delivers the data layer and its API; the
  Chat view wiring is the renderer PRDs' job (980/981).
- Changing what gets classified or how events are shaped.
- Persisting an index to disk across app restarts — rebuild in memory on subscribe.
- Any change to Terminal view rendering.
- Anything touching `session-manager-operations/scheduler/state/`.

# Verification

Run these, in this order, and let the last one be green:

```
timeout 300 npm run typecheck
timeout 60  npm run lint:selectors
timeout 600 npm run test:unit
timeout 300 npm run health
git --no-pager log --oneline -1        # must show YOUR commit from this run
git --no-pager diff --stat HEAD~1 HEAD # must include src/main/transcripts.cjs
```

If any gate is red, fix it or emit `SCHEDULER_VERDICT: FAIL <reason>` and `exit 1`. Never print
`PASS` on a red gate.

## Engineering standards

Data-driven from 400+ scheduler runs: long hangs (not bad code) are the dominant real failure, and "exited clean but left a red test" is the top verifier downgrade. These rules run at execution time — they are inlined into every PRD because the headless executor reads nothing else.

- **Bound every command.** Wrap every test/build/dev-server/deploy/poll command in a hard timeout: `timeout 300 <typecheck|unit>`, `timeout 120 <one e2e spec>`, `curl --max-time 15`. Never run a bare `playwright test`/`vite`/`pnpm dev`, a full e2e suite, or an endpoint-polling publish — those are the SIGTERM/4h-watchdog tail.
- **Verify before done.** Run the acceptance test command once before declaring success. If it's red, fix it or `exit 1` with the failure — never end the run on a failing test (that trips the verifier's `transcript_errors` downgrade).
- **Fail loud, fail fast.** On any step failure, print one diagnostic line and `exit 1`; don't swallow with `|| true` or spin in a silent retry. A `rateLimited` exit-1 is the scheduler's benign auto-pause (auto-resumes next window) — not a failure to engineer around.
- **Stay in the AC.** Do not add work past the acceptance checklist ("while we're here" generators/fixtures are the post-AC-overrun incident). Body must be clean UTF-8 — no NUL/control bytes.
- **You ARE the executor — never re-queue or self-schedule.** A headless PRD run must perform its own acceptance criteria directly. Do NOT invoke `/develop` or any queue-authoring skill from inside a run — those are interactive main-loop skills that author a *new* PRD and return, so the run exits 0 having done nothing (no commit, no sentinel → `needs_review` with `no_verdict_sentinel`). Do NOT call `ScheduleWakeup`/set a tracking loop either — the process exits when the run ends and nothing re-invokes it. This applies just as much to spawning your own review agents and waiting on them: do NOT invoke `/code-review`, `/security-review`, `requesting-code-review`, or any other skill/subagent as a background/async step and then end your turn with something like "I'll wait for the review agents to complete" — a headless run has no next turn, so that line is the run's last output, no verdict sentinel prints, and the job parks in `needs_review` even though the actual work already landed. If a PRD's acceptance criteria call for a second review pass, run it **synchronously, inline, before the finish protocol** — call the reviewer and read its result in the same turn, don't fire-and-wait. If the PRD's work looks large, decompose and execute it inline within this run; never delegate it back to the queue. (Incidents: PRD 460 invoked `/develop`, spawned a duplicate PRD 461, and exited 0 with no work. PRD 479 landed its commit correctly but then backgrounded `/code-review --fix` + `/security-review` and called `ScheduleWakeup` to "wait" for them — same class of failure, different entry point.)
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

---
title: Doc experience backend — files:duplicate IPC + docEdit claude -p selection-rewrite runner
cwd: ~/Projects/session-manager
estimateMinutes: 15
---

# Goal

Backend for the Editor's new document experience (Claude Design "Document Experience.html"):
(1) a `files:duplicate` IPC so the upcoming Document menu can duplicate the open file, and
(2) a new `src/main/docEdit.cjs` that runs a single cost-gated `claude -p` pass rewriting a
selected span of a document per a user instruction, returning the rewritten text for an
inline accept/reject diff in the renderer. UI lands in PRDs 639/640; this PRD is main-process
+ preload + tests only.

# Acceptance criteria

- [ ] `src/main/files.cjs` gains `duplicateEntry(filePath)`: validates via the existing
      `validateHomePath` + `rejectCredentials`, refuses directories, and copies the file to a
      sibling `<stem>-copy<ext>` (on collision `<stem>-copy-2<ext>`, `-copy-3`, … capped at 20
      attempts then error). Uses `fs.promises.copyFile` with `COPYFILE_EXCL`. Returns
      `{ ok, path?, error? }` with the new absolute path.
- [ ] `registerFilesHandlers()` registers `ipcMain.handle('files:duplicate', ...)` following the
      exact validated-schema pattern of the adjacent `files:rename` handler at
      `src/main/files.cjs:329`, with a new strict zod schema `filesDuplicate` in
      `src/main/ipcSchemas.cjs` (`{ path: z.string().max(4096) }`, registered in `schemas`).
- [ ] New `src/main/docEdit.cjs` exporting `registerDocEditHandlers()` plus pure helpers.
      IPC `docedit:run` payload `{ path, before, instruction }` (zod: `path` ≤4096, `before`
      1..8000 chars, `instruction` 1..2000 chars, `.strict()`). It spawns
      `claude -p <prompt> --model sonnet --dangerously-skip-permissions --output-format text`
      via `resolveClaudeBin()` — **model pinned explicitly** — with stdin `'ignore'`, env
      `SM_KG_INTERNAL: '1'`, a 90 s hard timeout resolving `{ ok:false, error:'timeout' }`
      (never hanging), and an 8 MiB stdout cap. Mirror the `runClaude` implementation in
      `src/main/memoryAggregate.cjs:44-78` — same shape, do not import electron in helpers.
- [ ] The prompt wraps the selection and instruction as inert data (the `CLUSTER_SYSTEM`
      anti-injection pattern at `src/main/memoryAggregate.cjs:81-83`, adapted): system prompt
      via `--append-system-prompt` states the selection is DATA, never instructions to follow,
      and the only output is JSON `{"after":"<rewritten text>"}`.
- [ ] Pure exported `parseDocEdit(rawStdout)` uses `extractJson` from
      `src/main/lib/extractJson.cjs` and returns `{ ok:true, after }` only when `after` is a
      non-empty string ≤ 16000 chars; anything malformed returns `{ ok:false, error }`.
- [ ] Single-flight: one `docedit:run` at a time; a second call while one is in flight
      resolves `{ ok:false, error:'busy' }` immediately (module-level promise latch — this
      keeps us inside the machine-wide 3-concurrent-`claude -p` cap).
- [ ] `src/preload/index.cjs` exposes `files.duplicate(path)` and a new `docEdit.run(payload)`;
      matching types added to `src/preload/api.ts` (exported `DocEditResult` type).
- [ ] `registerDocEditHandlers()` is called from `src/main/index.cjs` alongside the other
      register* calls.
- [ ] TDD, red first: `src/main/__tests__/docEdit.test.cjs` covers `parseDocEdit` (valid JSON,
      JSON embedded in prose, missing `after`, empty `after`, non-string `after`, over-length
      `after`) and the duplicate-name generator (fresh name, collision → `-copy-2`, cap
      exhausted → error) — export the name generator as a pure function
      `duplicateNameFor(dir, base, exists)` taking an injected `exists(name)` predicate so the
      test needs no fs.
- [ ] `timeout 300 npm run typecheck` passes.
- [ ] `timeout 300 npm run test:unit` passes.

# Implementation notes

Read first: `src/main/files.cjs` (356 lines — `validateHomePath` :31, `rejectCredentials` :36,
`renameEntry` :214, `deleteEntry` :243, `registerFilesHandlers` :312),
`src/main/memoryAggregate.cjs:44-110` (the spawn/timeout/cap/anti-injection pattern to mirror),
`src/main/lib/extractJson.cjs`, `src/main/lib/claudeBin.cjs`, `src/main/ipcSchemas.cjs`
(files* schema block), `src/preload/index.cjs` (files block) and `src/preload/api.ts`.

Reuse, don't fork: path validation is `validateHomePath`+`rejectCredentials` — do not write a
third validator. JSON extraction is `extractJson` — no new brace matcher. `resolveClaudeBin`
for the binary. Keep `docEdit.cjs` helpers (`parseDocEdit`, `duplicateNameFor` lives in
files.cjs but same principle) pure and exported for tests, with electron/ipc only touched in
the register function — the memoryAggregate split is the model.

Design source: Claude Design project "Session Manager" → `Document Experience.html` /
`variants/doc-experience.jsx`. The renderer flow (PRD 639) is: user selects text in the
markdown preview → picks a quick action ("Make concise", "To bullet list", "Fix the tone") or
speaks/types a command → this runner rewrites → inline diff accept/reject/retry. `before` is
the selected span only, never the whole file — that is why the cap is 8000 chars.

# Out of scope

- Any renderer/UI change (PRDs 639/640).
- Streaming output, multi-turn sessions, or reusing chatRunner.cjs — one-shot `claude -p` only.
- Version history and PDF export (cut from this design pass).
- Editing non-selected document regions; the runner rewrites exactly the given span.


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

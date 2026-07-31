---
title: Extract transcripts.cjs's JSONL line classifier into its own pure module
cwd: ~/Projects/session-manager
estimateMinutes: 15
---

# Goal

`src/main/transcripts.cjs` (394 lines) currently bundles four distinct responsibilities in one
file: (1) generic byte-offset file-tailing with inode-rotation/truncation handling
(`readDelta`), (2) domain-specific parsing of a raw Claude Code JSONL line into a classified
`{kind, data, raw}` event (`classifyLine`, `trimContentArray`, `makeRaw` — lines 46-133), (3)
subscription lifecycle + LRU resource pooling (`subscribe`/`release`/`closeTab`, lines 248-349),
and (4) fan-out of each classified event to three downstream consumers (ring buffer, IPC
broadcast, `usageMatrix`, OTEL — inside `doFlush`, lines 190-224).

Responsibility (2) is already effectively a pure, standalone unit — `classifyLine` has zero
dependency on `fs`/`chokidar`/IPC and is already separately exported from the module (line 392).
Pulling it into its own file makes it independently unit-testable (no chokidar/fs mocking needed
to test JSONL-shape parsing) and reusable by any future consumer that wants to interpret a raw
transcript line without subscribing to a live tail. This is a pure extraction — no behavior
change.

This PRD does **not** extract the generic file-tailing logic (`readDelta`) — there's no second
consumer for a generic tailer today, and pulling it out now would be speculative generality with
no real payoff yet (per this project's own "don't add abstractions beyond what the task requires"
convention). Only the classifier moves.

# Acceptance criteria

- [ ] Create `src/main/lib/classifyTranscriptLine.cjs` containing, moved verbatim (not
  rewritten): `MAX_RAW_STR`, `EXEMPT_TYPES`, `trimContentArray`, `makeRaw`, `classifyLine` — the
  exact code currently at `src/main/transcripts.cjs` lines 46-133, including all existing
  comments explaining the size-cap/exempt-types rationale.
- [ ] `src/main/transcripts.cjs` imports `classifyLine` from the new module
  (`const { classifyLine } = require('./lib/classifyTranscriptLine.cjs')`) and removes the moved
  code from its own body. `transcripts.cjs`'s own `module.exports` still re-exports `classifyLine`
  (line 392) for backward compatibility with any existing importer — confirm via
  `grep -rn "require.*transcripts.cjs" src/` whether anything outside this file currently imports
  `classifyLine` from `transcripts.cjs` directly, and if so, leave that re-export in place rather
  than forcing every caller to update its import path in this PRD.
- [ ] No behavior change: `doFlush`'s call to `classifyLine(obj)` (line 199) and everything
  downstream of it (ring buffer, `usageMatrix.recordEvent`, IPC broadcast, OTEL) is untouched.
- [ ] Move (or add, if none exists) unit tests for `classifyLine`/`trimContentArray`/`makeRaw` to
  target the new module directly — search `find src/main -iname '*transcript*spec*' -o -iname
  '*transcript*test*'` first; if classification-specific test cases already exist inside a
  `transcripts.spec.cjs`-style file, move them to a new
  `src/main/lib/classifyTranscriptLine.spec.cjs` (or this repo's equivalent test-file naming
  convention for `lib/` modules — check an existing `lib/*.spec.cjs` file for the pattern) rather
  than duplicating them in both places.
- [ ] `timeout 300 npm run typecheck` passes.
- [ ] `timeout 120 npx vitest run <the test files you touched>` passes.

# Implementation notes

- Read `src/main/transcripts.cjs` lines 1-134 in full before starting — the extraction boundary
  is exactly "everything with zero dependency on `fs`/`chokidar`/IPC/`os`," which is lines 46-133
  (constants through `classifyLine`'s closing brace). `transcriptPath`/`encodeCwd` (lines 40-44)
  stay in `transcripts.cjs` — they're path-resolution helpers, not classification, and are already
  separately concerned.
- Check `src/main/lib/` for its existing module style (plain `module.exports = {...}` at the
  bottom, JSDoc comments above each exported function) and match it — don't introduce a different
  export convention than the rest of that directory uses.
- This is a mechanical move, not a rewrite — do not "clean up" or restructure `classifyLine`'s
  internal logic while relocating it; that's a separate concern from this PRD's scope.

# Out of scope

- Do not extract `readDelta`/the file-tailing logic — no second consumer exists for it today;
  leave it in `transcripts.cjs`.
- Do not touch the subscription/LRU-pool logic (`subscribe`/`release`/`closeTab`,
  `MAX_TRANSCRIPT_SUBS`, `LRU_CAP`) or the fan-out logic inside `doFlush` — both stay exactly
  where they are.
- Do not change `classifyLine`'s parsing behavior, size caps, or exempt-types list — this PRD
  relocates code, it does not alter what it does.
- Do not update every external caller's import path if `transcripts.cjs` can just re-export
  `classifyLine` from the new location — minimize the diff's blast radius.

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
- **Negative-assertion checks must exit 0 when clean.** A check that verifies the *absence* of something (a `grep` that should find nothing, "no leftover X", `diff` expecting no change) must return exit 0 on the clean case. A bare `grep` exits **1 on no-match** — so the *success* path surfaces as `is_error=true` and the verifier downgrades a perfect run to `needs_review`. Always invert: `if <detector>; then echo "HALT: <what was found>"; exit 1; fi; echo clean`. Never let the no-match/empty path carry the non-zero exit.
- **Recover or annotate every error — don't strand a Traceback in the transcript.** The verifier downgrades an otherwise-perfect run to `needs_review` when a `Traceback`/`Error` appears with *no visible recovery within ~10 lines* (the `transcript_errors` heuristic — the single most common false-positive on green deliverables). When a probe errors, immediately re-run the corrected version *or* print one line `# expected/handled: <why>` right after, so recovery is adjacent. Prefer a small temp `.py`/`.js` file over a fragile multi-quote one-liner.
- **An *expected* bounded-timeout (exit 124) must be annotated, not bare.** Wrap it so the cap is a success-with-note rather than a bare `Exit code 124`.
- **Finish so the verifier auto-clears you.** The scheduler appends a finish protocol that requires you to COMMIT your work and emit `SCHEDULER_VERDICT: PASS` (or `FAIL <reason>` + `exit 1`) as the literal last line. Honor it exactly: a *truthful* PASS plus a commit that landed during the run is what lets the verifier override incidental transcript noise. A job that exits 0 with **uncommitted** changes, or with no PASS sentinel, is the #1 cause of needless `needs_review`. Never print PASS on a red gate.
- **Don't leak expected-error text into tool output.** When a step is *expected* to error, capture it and surface a clean token instead of the raw exception.
- **End green: run the acceptance/test gate LAST, and let nothing error after it.** Order the run so the last command is the green AC gate — do any intentionally-failing step early, never after the gate.
- **The verdict sentinel is your authoritative "I passed" signal — emit it truthfully.** Never print `PASS` when the gate is red.

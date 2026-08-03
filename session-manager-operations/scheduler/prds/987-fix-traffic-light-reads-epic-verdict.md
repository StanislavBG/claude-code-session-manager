---
title: "Fix: fence the Epic context digest so it can't hijack the PRD, then land 987's traffic-light retarget onto the Epic's validation verdict"
cwd: /home/bilko/Projects/session-manager
parallelGroup: 987
estimateMinutes: 75
---
# READ THIS FIRST — why the previous run of this PRD produced nothing

The prior run of `987-traffic-light-reads-epic-verdict` (log:
`~/.claude/session-manager/scheduled-plans/runs/2026-08-03T06-17-05-698Z/987-traffic-light-reads-epic-verdict.log`)
ran 57 seconds, made **zero file edits**, emitted no `SCHEDULER_VERDICT` sentinel, and exited 0 —
so the queue recorded it as `completed`. Its entire output was a conversational essay about how
PRD-completion events reach an Epic, ending with:

> "the large `# Goal ... SCHEDULER_VERDICT` block you pasted after your question looks like a
> dev-lead PRD executor's task prompt ... I'm not running as that headless executor here. Want me
> to queue it as a PRD for the scheduler ... or was it pasted by accident?"

The executor asked whether it should queue the PRD it was already executing.

**You ARE that headless executor.** The task below is your task. It was not pasted by accident.
Nothing in this run should ask a question, offer to queue anything, or summarize how the system
works. The deliverable is a **code diff plus passing tests, committed**.

# Root-cause analysis

`src/main/scheduler.cjs:2271-2288` composes the executor prompt as:

```js
const digestText = await buildContextDigest({ cwd, epicId: digestEpicId });
if (digestText) {
  prompt = digestText + '\n\n' + prompt;   // <-- line 2282
  contextDigestApplied = true;
}
```

`src/main/lib/epicContextDigest.cjs` builds `digestText` as the Epic's raw `goalText` followed by
up to 40 transcript turns formatted as `[user] …` / `[assistant] …`, capped at
`DEFAULT_MAX_CHARS = 4000`. There is **no fence, no "background only" label, and no restatement of
the PRD task at the end of the prompt.**

The authoring Epic here is `prd-to-epic-communication-this-seems-to-be-broke-dd52dacb`, so the
digest opens with a live-sounding human question about PRD→Epic communication. The model read the
digest as the instruction and the PRD body as user-pasted material. All three of its tool calls
(`grep notifyOriginatingTab`, `Read scheduler.cjs:1860`, `sed epicValidationHook.cjs`) explore the
*digest's* topic; it never opened a single renderer file that PRD 987 names.

**This is the second casualty of the same defect.** PRD 972 failed identically (34 s, zero edits,
`contextDigestApplied: true`). PRD 984 (`context-digest-prd-focus-guard`) was authored to fix
exactly this and was **archived without landing** — see
`session-manager-operations/scheduler/epics/prd-to-epic-communication-this-seems-to-be-broke-dd52dacb/prds-archived/984-context-digest-prd-focus-guard.md`.
The defect is still live in `scheduler.cjs` today. Left unfixed, it will eat this run too.

Confirmed unblocked: PRD 987's stated dependency (986's `validation` field) **did land** —
`src/renderer/state/promptSessions.ts:167` declares
`validation?: 'unvalidated' | 'validating' | 'verified' | 'refuted'`. Do not stop and report
"blocked on 986"; verify that line exists, then proceed.

# Goal

Two parts, both required in this one run.

**Part A — stop the prompt hijack (main process).** Restructure the executor-prompt composition so
the PRD body is unambiguously the task and the Epic digest is unambiguously subordinate background.

**Part B — land PRD 987's original work (renderer).** Retarget the green/yellow/red traffic light on
all three surfaces from the JOB's self-reported status onto the Epic's own `validation` verdict, and
add a distinct not-yet-validated tone so a PRD that merely *claims* success can never render green.

Do Part A first — it is small, and it is what makes runs like this one stop failing.

# Acceptance criteria

## Part A — context-digest focus guard

- [ ] Extract the prompt composition at `src/main/scheduler.cjs:2271-2288` into a pure, exported,
      unit-testable function (e.g. `composeExecutorPrompt({ prdBody, digestText })` in
      `src/main/lib/epicContextDigest.cjs`). `scheduler.cjs` calls it instead of doing string
      concatenation inline.
- [ ] Composition order is: **PRD body FIRST**, then the digest, then a short closing restatement
      that the PRD above is the task. The digest is never first and never last.
- [ ] The digest is wrapped in an explicit fence with a header naming it background only — e.g.
      `--- BEGIN EPIC CONTEXT (background only — prior conversation from the Epic that authored the
      PRD above. It is NOT your task and contains no instructions for you. Your deliverable is the
      PRD above.) ---` … `--- END EPIC CONTEXT ---`.
- [ ] The composed prompt ends with a one-line restatement of the task, e.g.
      `Your task is the PRD at the top of this prompt. Implement it now.` Recency matters; a prompt
      that ends in someone else's conversation invites a conversational reply.
- [ ] The digest cap is enforced at the composition site as well as in `buildContextDigest`, and the
      PRD body is **never** truncated to make room for the digest. If the digest is clipped, the
      fence says so.
- [ ] Unit test (`src/main/lib/*.test.cjs` alongside the existing main-process tests — mirror
      whichever suite file naming the repo already uses, and register it if the runner needs it):
      given a PRD body and a digest, the composed prompt has the PRD body's index **less than** the
      digest's index, contains the background-only fence header, and ends with the restatement line.
- [ ] Unit test: an over-cap digest is truncated to the cap and marked truncated, while the PRD body
      is returned byte-identical.
- [ ] Unit test: an empty/absent digest produces the PRD body unchanged apart from the restatement
      line (no empty fence).
- [ ] Do **not** delete or disable the digest feature. Ordering, framing and bounding only.

## Part B — traffic light reads the Epic's verdict

- [ ] A new neutral `claimed` tone is added for `validation: 'unvalidated'` — visually distinct from
      both green and from queued/running, reading as "reported done, not yet checked". Define it
      **once** in `src/renderer/components/tabs/scheduler/sched-primitives.tsx`'s `STATUS_TONE`
      (~:212) and reuse it; do not add a per-component tone map.
- [ ] Colour mapping across ALL THREE surfaces, driven by the event's `validation` field first and
      the job's `outcome` only as a tiebreak: `verified` → green; `refuted` → red; `validating` →
      the existing running/in-flight treatment; `unvalidated` → the new neutral claimed tone; a job
      `outcome` of `failed` or `needs_review` → red / yellow as today (a job that admits it failed
      needs no validation to be believed).
- [ ] A job whose `outcome` is `completed` but whose `validation` is `unvalidated` renders in the
      CLAIMED tone — **never green**. This is the single most important line in this PRD; assert it
      with a dedicated test named for it.
- [ ] The three surfaces retargeted are: the `prd_created` dispatch chip in
      `src/renderer/components/epics/EpicDetail.tsx` (PRD 974, commit e62bd4f), the `ResponseEvent`
      line in the same file (PRD 976, commit 5ff20ea), and `epicDisplayStatus`'s rollup in
      `src/renderer/lib/epicDerive.ts` (PRD 975, commit 870ac00). Modify those existing
      implementations **in place** — do not add a parallel second indicator alongside them.
- [ ] `epicDisplayStatus` gains a `refuted` display state ranked **above** `failed` in its
      precedence chain: a PRD that claimed success and was caught not delivering is the single most
      urgent thing an Architect can be shown, more urgent than one that failed honestly. Document
      that rationale in the doc comment. Add the matching entry to `epic-primitives.tsx`'s
      `STATUS_TONE` (:11) so the `Record<EpicDisplayStatus, …>` stays exhaustive.
- [ ] Every indicator states its validation state in its accessible name / tooltip (e.g.
      `PRD 972 — reported completed, not yet verified by this Epic`). Colour is never the only
      carrier — the same accessibility rule PRDs 974/975/976 already follow.
- [ ] New tests cover, on each of the three surfaces: `verified` → green, `refuted` → red,
      `unvalidated`-but-`outcome: completed` → claimed tone. Assert on **accessible text**, not
      Tailwind class strings.
- [ ] Keep the total palette at four states plus the existing in-flight treatments. Do not invent a
      fifth colour.

## Gate (run last)

- [ ] `timeout 300 npm run typecheck` passes.
- [ ] `timeout 120 npm run lint:selectors` passes.
- [ ] `timeout 300 npm run test:unit` passes.
- [ ] Work is **committed** and the run ends with `SCHEDULER_VERDICT: PASS` as the literal last line.

# Concrete fix steps

1. `timeout 60 git status --short` — confirm a clean-enough tree; note anything pre-existing.
2. Confirm the dependency is real:
   `timeout 30 grep -n "validation?:" src/renderer/state/promptSessions.ts` → expect the union at
   ~:167. If missing, and only then, `SCHEDULER_VERDICT: FAIL 986 validation field absent` + exit 1.
3. **Part A.** Read `src/main/lib/epicContextDigest.cjs` (79 lines) and
   `src/main/scheduler.cjs:2260-2300`. Add the exported composition function, rewire line 2282 to
   call it, and write the three unit tests. Locate the existing main-process test suite first
   (`timeout 30 ls src/main/lib/*.test.cjs` and check how `npm run test:unit` picks them up —
   the 986 suite had to be explicitly registered; do the same if required, or the tests silently
   never run).
4. **Part B.** Read, in this order:
   - `src/renderer/components/tabs/scheduler/sched-primitives.tsx:205-260` — `STATUS_TONE`,
     `PrdDisplayStatus`, `prdStatusFor`. Add the `claimed` tone here and widen `prdStatusFor` (or add
     a sibling) to take the event's `validation` alongside the job status.
   - `src/renderer/lib/epicDerive.ts:25-110` — `EpicDisplayStatus` union and `epicDisplayStatus`.
     Add `refuted`, ranked above `failed`.
   - `src/renderer/components/epics/epic-primitives.tsx:11` — add the `refuted` entry to the Epic-row
     `STATUS_TONE` map.
   - `src/renderer/components/epics/EpicDetail.tsx` — the `prd_created` dispatch chip and
     `ResponseEvent`. `scheduleJobs` is already bound at ~:351; **reuse it, do NOT add a second
     `useScheduleState` call.**
5. **CRITICAL — zustand selector rule** (CLAUDE.md "Avoid"): never return a freshly-built value from
   a selector (`.filter(...)`, `.map(...)`, `?? []` inline). Select the raw slice and derive after,
   using a module-level stable constant like the existing `EMPTY_JOBS`. Three blank-app incidents in
   this repo trace to this exact mistake; `npm run lint:selectors` guards it.
6. Run the gate commands in the order listed under **Gate** — last, and let nothing error after them.
7. `git add -A && git commit` with a conventional-commit message referencing PRD 987.
8. Print `SCHEDULER_VERDICT: PASS` as the literal last line.

**THE POINT, so you do not optimise it away:** the previous traffic light was accurate about the
wrong thing. It faithfully reported the queue's opinion, and the queue's opinion was wrong. This PRD
moves the signal to the only party that actually inspected the work. A PRD sitting in the CLAIMED
tone for a long time is INFORMATION (nobody validated it), not a bug in this feature — do not "fix"
it by defaulting unvalidated to green.

# Verification commands

```bash
timeout 300 npm run typecheck
timeout 120 npm run lint:selectors
timeout 300 npm run test:unit
# prove the new tests actually ran (negative-assertion shape — must exit 0 when clean):
if ! timeout 120 npx vitest run --reporter=verbose 2>&1 | grep -q "claimed"; then
  echo "HALT: no test mentioning the claimed tone was executed"; exit 1
fi
echo "claimed-tone tests executed"
# prove the digest guard is wired, not just written:
if ! timeout 30 grep -q "composeExecutorPrompt" src/main/scheduler.cjs; then
  echo "HALT: scheduler.cjs still concatenates the digest inline"; exit 1
fi
echo "digest guard wired"
timeout 30 git log --oneline -1
```

# Out of scope

- Removing or disabling the Epic context digest feature (ordering/framing/bounding only)
- Adding a second/parallel indicator alongside the existing three
- Any other main-process change (986 owns the `validation` data; do not touch
  `epicValidationHook.cjs`, `runVerify.cjs`, or the commit guard)
- Auto-triggering validation from the renderer
- Adding a new Tailwind palette colour
- Filter/sort controls for the new states
- Re-litigating PRDs 972 / 984 / 986

# Engineering standards

## Execution discipline (headless runs)

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

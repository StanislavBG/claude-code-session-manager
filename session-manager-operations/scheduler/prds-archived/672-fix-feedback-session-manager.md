---
title: "Fix: watchdog emits feedback PRDs with empty skill/standards inlines"
cwd: /home/bilko/Projects/session-manager
parallelGroup: 672
estimateMinutes: 45
---

# Goal

Fix `emitFeedbackPRD` in `scripts/lib/watchdogHelpers.cjs` so the auto-emitted
`NN-feedback-<project>.md` PRDs actually contain the inlined process-feedback procedure and
engineering standards — and so the emitter **refuses to write a PRD at all** when either inline
resolves empty, instead of silently shipping a hollow template to the scheduler.

# Root-cause analysis (what went wrong and why)

Scheduled job `672-feedback-session-manager` exited 0 with `SCHEDULER_VERDICT: PASS` after ~22s
and $0.34, having done no work and having left one of its own acceptance criteria unmet.

The failing artifact is the PRD itself, not the run. Open
`/home/bilko/.claude/session-manager/scheduled-plans/prds/672-feedback-session-manager.md` — it is
**1313 bytes**. It says:

> Follow the inlined process-feedback procedure below exactly. No skills are loaded in
> headless execution — the procedure is fully self-contained.

…and then nothing follows. Its final two lines are the heading `## Engineering standards` and a
blank line. Both inlines are empty.

Why: `scripts/lib/watchdogHelpers.cjs` defines (lines ~115-120):

```js
const DEFAULT_SKILL_PATH = path.join(
  os.homedir(), '.claude', 'skills', 'process-feedback', 'SKILL.md',
);
const DEFAULT_STANDARDS_PATH = path.join(
  os.homedir(), '.claude', 'skills', 'develop', 'standards.md',
);
```

Neither path exists. `~/.claude/skills/` now contains only `systematic-debugging/` and
`test-driven-development/`. Those two skills were relocated into the `session-manager-dev` plugin
and now live at:

- repo source of truth: `<cwd>/plugins/session-manager-dev/skills/process-feedback/SKILL.md`
  and `<cwd>/plugins/session-manager-dev/skills/develop/standards.md`
- installed plugin cache:
  `~/.claude/plugins/cache/session-manager/session-manager-dev/<version>/skills/...`

In `emitFeedbackPRD` (lines ~408-424) both `fs.readFileSync` calls are wrapped in a `try/catch`
whose only action is `process.stderr.write('[emitFeedbackPRD] warning: ... not readable')`. Nobody
reads watchdog stderr. So `skillBody` and `standardsBody` fall through as `''`, the template string
is assembled anyway (lines ~427-463), and a hollow PRD is atomically written into the queue.

The downstream damage: the headless Sonnet executor received a PRD promising a self-contained
procedure and got none, plus zero execution-discipline rules. It improvised — invented "the skill's
quick-exit rule (step 0)" that exists nowhere in its prompt, ran one `ls`, saw no open feedback
files, then declared PASS while acceptance criterion #3 ("`feedback/README.md` self-improved with
lessons from this pass") was never even attempted. That is a *lying* PASS: the exact silent-failure
mode the standards section below warns against.

Note for the executor: this is **not** the "delegated instead of executed" failure class. The failed
run invoked no `Skill` tool and no `ScheduleWakeup`. Do not write a fix aimed at self-delegation.

Two defects to fix, both required:

1. **Wrong paths** — the emitter looks for the skills where they no longer are.
2. **Silent degradation** — a missing/empty inline produces a PRD instead of an error. Even once the
   paths are fixed, the next relocation must fail loudly rather than queue another hollow PRD.

# Concrete fix steps

All paths below are relative to `/home/bilko/Projects/session-manager`.

## 1. Resolve the skill and standards paths through a candidate list

In `scripts/lib/watchdogHelpers.cjs`, replace the two hard-coded `DEFAULT_*_PATH` constants with a
resolver that tries candidates in order and returns the first readable one. Keep it dependency-free
(the watchdog runs outside Electron via `node`).

Candidate order, most-specific first:

1. `path.join(cwd, 'plugins', 'session-manager-dev', 'skills', <skill>, <file>)` — the repo-local
   copy, correct when the swept project *is* session-manager or vendors the plugin.
2. Newest versioned dir under
   `~/.claude/plugins/cache/session-manager/session-manager-dev/*/skills/<skill>/<file>` — the
   installed plugin. Enumerate with `fs.readdirSync` and pick the lexicographically-highest entry
   that contains the target file (do NOT hard-code `0.1.0`).
3. Legacy `~/.claude/skills/<skill>/<file>` — kept last so an old install still works.

Because candidate 1 depends on `cwd`, the resolution must move *inside* `emitFeedbackPRD` (which
receives `cwd`) rather than staying as module-level constants. Preserve the existing
`skillPath` / `standardsPath` option overrides used by the tests: if the caller passes an explicit
path, use it verbatim and skip the candidate search. Suggested shape:

```js
function resolveSkillFile(cwd, skillName, fileName) { /* returns absolute path or null */ }
```

Export it alongside the existing exports so it is unit-testable.

## 2. Hard-fail the emit when an inline is empty

In `emitFeedbackPRD`, after computing `skillBody` and `standardsBody`, replace the swallowing
`try/catch` behaviour with a guard **before** the atomic write:

- If `skillBody` is empty/whitespace, or `standardsBody` is empty/whitespace, do **not** write the
  PRD. Write one diagnostic line to stderr naming which inline was empty and every candidate path
  that was tried, and return `{ emitted: false, reason: 'missing-inline' }`.
- Keep `emitFeedbackPRD`'s existing return-shape contract (`{ emitted, reason }` / `{ emitted, slug,
  prdPath }`) so `sweep()` keeps counting it under `skipped` without throwing.
- `sweep()` (lines ~498-525) must surface the new reason: count it as skipped and log it, so a
  future relocation shows up in the watchdog log rather than as a hollow queued PRD.

Also add the same guard so a *partially* populated PRD can never be produced: assemble and write
only after both inlines validate.

## 3. Additionally verify the standards inline is the right section

The emitted PRD must end with the full `## Execution discipline (headless runs)` bullet list from
`plugins/session-manager-dev/skills/develop/standards.md`. The existing
`stripLeadingH1(stripFrontmatter(...))` handling stays as-is — just confirm after the fix that the
rendered PRD contains the literal string `You ARE the executor — never re-queue or self-schedule`.

## 4. Tests

Extend `scripts/__tests__/feedback-sweep.test.cjs` (and/or
`scripts/__tests__/watchdog-helpers.test.cjs`) with:

- a case where the repo-local `plugins/session-manager-dev/skills/...` fixtures exist → PRD is
  emitted and its body contains both fixture bodies (assert on a distinctive substring from each);
- a case where **no** candidate resolves → `emitted === false`, `reason === 'missing-inline'`, and
  **no file is created** in the fixture `prdsDir`;
- a case where the skill resolves but standards does not → same `missing-inline` refusal;
- a case asserting the plugin-cache candidate picks the highest version directory when two exist.

Use `fs.mkdtempSync(path.join(os.tmpdir(), ...))` fixtures as the existing tests do; do not touch
the real `~/.claude` tree.

## 5. Delete the poisoned PRD from the queue

The hollow `672-feedback-session-manager.md` is still in
`~/.claude/session-manager/scheduled-plans/prds/`. It has already run and PASSed, so it is inert,
but leaving it means the emitter's own `prdDupRe` dedup (line ~388) will refuse to emit a corrected
`NN-feedback-session-manager.md` for this project forever. Remove it:

```
rm -f /home/bilko/.claude/session-manager/scheduled-plans/prds/672-feedback-session-manager.md
```

Do NOT delete this fix-plan PRD (`672-fix-feedback-session-manager.md`) — you are executing it.

# Verification commands

Run each with a hard timeout. Order matters: the AC gate runs last and must end green.

```
timeout 300 npm run typecheck
timeout 300 npx vitest run scripts/__tests__/feedback-sweep.test.cjs scripts/__tests__/watchdog-helpers.test.cjs
```

Then prove the real resolver finds the real files (no fixtures) — a negative-assertion check that
exits 0 when clean:

```
timeout 60 node -e '
const h = require("/home/bilko/Projects/session-manager/scripts/lib/watchdogHelpers.cjs");
const cwd = "/home/bilko/Projects/session-manager";
const s = h.resolveSkillFile(cwd, "process-feedback", "SKILL.md");
const d = h.resolveSkillFile(cwd, "develop", "standards.md");
if (!s || !d) { console.log("HALT: unresolved", {s, d}); process.exit(1); }
console.log("resolved-ok", s, d);
'
```

Then a dry emit into a temp dir, asserting the body is fully populated:

```
timeout 60 node -e '
const fs = require("fs"), os = require("os"), path = require("path");
const h = require("/home/bilko/Projects/session-manager/scripts/lib/watchdogHelpers.cjs");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "prd-emit-"));
const r = h.emitFeedbackPRD("/home/bilko/Projects/session-manager", { prdsDir: tmp, queuePath: path.join(tmp, "queue.json") });
if (!r.emitted) { console.log("skipped:", r.reason, "(ok only if no open feedback)"); process.exit(0); }
const body = fs.readFileSync(r.prdPath, "utf8");
if (body.length < 8000) { console.log("HALT: PRD too small, inlines likely empty:", body.length); process.exit(1); }
if (!body.includes("You ARE the executor — never re-queue or self-schedule")) { console.log("HALT: standards inline missing"); process.exit(1); }
console.log("emit-ok", body.length, "bytes");
'
```

Note: if session-manager currently has no open feedback items the emit returns
`{emitted:false, reason:"no-open-feedback"}` — in that case exercise the populated-body assertion
through the vitest fixtures instead, and say so explicitly in your finish output.

Finally confirm the poisoned PRD is gone (inverted so the clean case exits 0):

```
if [ -f /home/bilko/.claude/session-manager/scheduled-plans/prds/672-feedback-session-manager.md ]; then echo "HALT: poisoned PRD still present"; exit 1; fi; echo clean
```

# Acceptance criteria

- [ ] `scripts/lib/watchdogHelpers.cjs` resolves the process-feedback SKILL.md and develop
      standards.md via an ordered candidate list (repo-local plugin dir → newest
      `~/.claude/plugins/cache/session-manager/session-manager-dev/*/skills/...` → legacy
      `~/.claude/skills/...`), with explicit `skillPath`/`standardsPath` overrides still honored.
- [ ] `emitFeedbackPRD` writes NO file and returns `{ emitted: false, reason: 'missing-inline' }`
      when either inline resolves empty or unreadable; `sweep()` counts and logs it.
- [ ] New unit tests cover: both inlines present → populated PRD; neither resolves → refusal with no
      file written; standards missing only → refusal; plugin-cache version selection picks newest.
- [ ] `timeout 300 npm run typecheck` passes.
- [ ] `timeout 300 npx vitest run scripts/__tests__/feedback-sweep.test.cjs scripts/__tests__/watchdog-helpers.test.cjs` passes.
- [ ] The resolver probe above prints `resolved-ok` for both files.
- [ ] The hollow `672-feedback-session-manager.md` is deleted from the prds dir.
- [ ] Work is committed and `SCHEDULER_VERDICT: PASS` is the literal last line.

# Out of scope

- Re-running or re-authoring the feedback pass itself (a corrected feedback PRD will be re-emitted
  by the watchdog sweep once this fix lands and the poisoned file is removed).
- Any change to the process-feedback or develop skill content.
- Changing the PRD template's wording or acceptance criteria — only the inlining mechanism.

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
- **Negative-assertion checks must exit 0 when clean.** A check that verifies the *absence* of something (a `grep` that should find nothing, "no leftover X", `diff` expecting no change) must return exit 0 on the clean case. A bare `grep` exits **1 on no-match** — so the *success* path surfaces as `is_error=true` and the verifier downgrades a perfect run to `needs_review`. Always invert: `if <detector>; then echo "HALT: <what was found>"; exit 1; fi; echo clean`. Never let the no-match/empty path carry the non-zero exit.
- **Recover or annotate every error — don't strand a Traceback in the transcript.** The verifier downgrades an otherwise-perfect run to `needs_review` when a `Traceback`/`Error` appears with *no visible recovery within ~10 lines* (the `transcript_errors` heuristic — the single most common false-positive on green deliverables). Two executor habits cause it: (1) **throwaway probes that error** — an inline `python -c` with a quoting/f-string slip, a wrong kwarg, a bad path. When a probe errors, immediately re-run the corrected version *or* print one line `# expected/handled: <why>` right after, so recovery is adjacent. Don't move on leaving a bare error as the last thing in that step. Prefer a small temp `.py` file over a fragile multi-quote `python -c` one-liner (inline f-string errors are the top source of stranded tracebacks). (2) See the timeout rule below.
- **An *expected* bounded-timeout (exit 124) must be annotated, not bare.** `timeout`-capping a genuinely long task you expect to hit the cap (a full-universe ingest, a long scan) is correct — but a bare `Exit code 124` reads as a failure to the verifier. Wrap it so the cap is a success-with-note: `timeout 120 <cmd> || { rc=$?; [ $rc -eq 124 ] && echo "hit time cap — idempotent/partial, rows persist incrementally; OK" || { echo "HALT: <cmd> failed rc=$rc"; exit 1; }; }`. (Distinguish 124 = expected cap from a real non-zero.) For work that legitimately needs longer than a safe cap, run it in the background and poll a bounded number of times rather than capping the foreground command.
- **Finish so the verifier auto-clears you.** The scheduler appends a finish protocol that requires you to COMMIT your work and emit `SCHEDULER_VERDICT: PASS` (or `FAIL <reason>` + `exit 1`) as the literal last line. Honor it exactly: a *truthful* PASS plus a commit that landed during the run is what lets the verifier override incidental transcript noise (a grep hit containing "Error", a TDD red-phase run, a debug Traceback) instead of parking the job in `needs_review` for a human. A job that exits 0 with **uncommitted** changes, or with no PASS sentinel, is the #1 cause of needless `needs_review`. Never print PASS on a red gate — a lying PASS turns the verifier into a silent-failure shipper.
- **Don't leak expected-error text into tool output.** The verifier pattern-matches transcript content for `Traceback`/`FAIL`/`Error:`. When a step is *expected* to error (a TDD red-phase test, an availability/existence probe, a "should raise" assertion), don't let the raw exception land verbatim — capture it and surface a clean token instead: `if python -c '…' 2>/dev/null; then echo PROBE_OK; else echo PROBE_ABSENT; fi`, or pipe the noisy run through a matcher that prints only `RED (expected)` / `GREEN`. When you retry a transient failure, re-run the **same command with the same description** — the verifier's self-recovery detector pairs a failed call with a later identical-description call that succeeds and clears it.
- **End green: run the acceptance/test gate LAST, and let nothing error after it.** The post-run verifier scans the transcript and downgrades to `needs_review` on error markers — and weighs the *final* portion of the run most heavily (a tool error in the last ~20% trips it even if everything actually passed). So order the run so the last command is the green AC gate: do any intentionally-failing step (e.g. a TDD red test, an expected-nonzero probe) **early**, never after the gate. If you must demonstrate a failure late, capture it so it doesn't surface as a raw `is_error`/`Traceback` (`… 2>&1 | tail` inside a conditional, or assert on the captured text) rather than letting it hit the transcript bare.
- **The verdict sentinel is your authoritative "I passed" signal — emit it truthfully.** The scheduler appends a FINISH PROTOCOL that ends by printing `SCHEDULER_VERDICT: PASS` once the AC gate is green and the commit has landed (or `SCHEDULER_VERDICT: FAIL <reason>` + `exit 1` otherwise). The verifier treats `PASS` + a commit that landed during the run as **authoritative** and overrides incidental transcript markers — so a *deliberately reproduced* red test (systematic-debugging) or a grep result containing the word "Error" will **not** false-trip `needs_review`, as long as the run genuinely ends green and committed. Never print `PASS` when the gate is red — that's the one thing that turns a safety net into a silent-failure machine.

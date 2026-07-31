---
title: "Fix: stop the completed-PRD resurrection loop (history.jsonl guard, clean-verdict investigations)"
cwd: /home/bilko/Projects/session-manager
parallelGroup: 689
estimateMinutes: 40
---

# Goal

Stop the scheduler from re-executing, and then auto-investigating, PRD slugs whose work already
landed and whose run already verified **clean**.

**Read this first: there is NOTHING wrong with the adminServer / localAdminHttp code.** PRD
689's entire acceptance checklist is committed and green (commits `cf0e51a`, `b1547b0`,
`1f89ee9`). Do **not** re-do that refactor, do not re-convert tests, do not touch
`src/main/lib/localAdminHttp.cjs`, `src/main/scheduler.cjs`'s admin routes, or
`src/main/lib/prdCreate.cjs`'s admin route. This PRD is about the **scheduler's own lifecycle
bookkeeping**.

# Root-cause analysis (what actually went wrong)

The run being "fixed" here (`runs/2026-07-31T07-38-29-081Z/689-fix-distribute-adminserver-routes.log`)
was a **success**:

- `meta.json`: `exitCode: 0`, `rateLimited: false`, `networkError: false`, 65s duration.
- `verdicts.json`: `{"verdict":"clean","reason":"no issues detected","downgradeTo":null,"sentinel":"pass"}`.
- The executor ran `npm run typecheck` (green), targeted vitest over the three admin test files
  (33 tests, green), full `npm run test:unit` (1256 tests, green), confirmed no `adminServer`
  references remain, confirmed the 127.0.0.1-only bind / OS-assigned port / `0o600` token file /
  `crypto.timingSafeEqual` posture in `localAdminHttp.cjs`, and printed a truthful
  `SCHEDULER_VERDICT: PASS`. It made no commit because there was genuinely nothing left to
  commit.

Despite that, three things went wrong in the scheduler:

**(1) `history.jsonl` does not exist, which silently disables the resurrection guard.**

`ls ~/.claude/session-manager/scheduled-plans/` shows `queue.json` but **no `history.jsonl`**.
In `src/main/scheduler.cjs`'s `syncPrdsIntoQueue` (around lines 855-916), an on-disk PRD `.md`
whose slug is not present in `jobs[]` is looked up via `queueHistory.historyTerminalBySlug()`.
That lookup exists precisely so an already-terminal slug is *not* resurrected — the comment says
so: *"it would get resurrected below as a fresh 'pending' entry and the scheduler would genuinely
re-execute an already-completed PRD"*. With no `history.jsonl` on disk the returned Map is empty,
every unmatched slug falls through to the `status: 'pending'` entry-construction block, and the
guard is inert.

**(2) The PRD `.md` stays live for 7 days after completion, so there is a week-long window in
which (1) can fire.**

`selectAutoArchivable` in `src/main/queueOps.cjs` (~lines 370-386) only archives a completed
PRD's `.md` once `now - finishedAt > HISTORY_RETENTION_MS` (`7 * 24 * 60 * 60_000`, see
`src/main/lib/schedulerConfig.cjs:35`). So
`session-manager-operations/scheduler/prds/689-fix-distribute-adminserver-routes.md` is still in
the live PRDs dir today, and every reconcile pass can re-discover it.

Observed end state in `queue.json` right after the clean run:

```json
{ "slug": "689-fix-distribute-adminserver-routes", "status": "pending",
  "runId": null, "startedAt": null, "finishedAt": null, "exitCode": null,
  "investigationDepth": 2 }
```

…i.e. it is queued to burn *another* full Sonnet run re-verifying already-shipped work. (The
original `689-distribute-adminserver-routes` row is correctly `completed` with
`completedBy: "689-fix-distribute-adminserver-routes"`.)

**(3) An auto-fix investigation fired even though the verdict was `clean`.**

`runs/2026-07-31T07-38-29-081Z/689-fix-distribute-adminserver-routes.investigation.log` shows an
Opus investigation starting at `07:41:49Z` — two minutes after a clean, exit-0 run — targeting
`689-fix-fix-distribute-adminserver-routes.md` (this very file) at `investigationDepth: 2`. A run
whose `verdicts.json` says `clean` and whose `meta.json` says `exitCode: 0` has, by definition,
nothing to diagnose. Every such spawn costs an Opus session and manufactures a depth-2
fix-of-a-fix PRD for shipped work.

**Related, already-queued, do NOT duplicate:**
`session-manager-operations/scheduler/prds/817-verifier-exempt-already-landed-slug-reruns.md`
covers a *different* pair of defects (a `pass_no_commit` exemption in `runVerify.cjs` for
already-landed slugs, and a terminal-status guard on `resetJobFields`). Read it before you start
so your changes compose rather than collide; if 817 has already landed when you run, adapt around
its code rather than reverting it. This PRD owns: history-independent resurrection guard,
archive-on-completion for a slug whose file is still live, and the clean-verdict investigation
guard.

# Fix steps

## Step 0 — Reconcile the live loop first (this is the user-visible bleeding)

```bash
cd /home/bilko/Projects/session-manager
git log --oneline -6
git status --short | head -40
ls -la ~/.claude/session-manager/scheduled-plans/history.jsonl 2>&1 || echo "history.jsonl absent (expected)"
node -e "const q=require('/home/bilko/.claude/session-manager/scheduled-plans/queue.json'); for (const j of q.jobs) if (j.slug.includes('689')) console.log(JSON.stringify({slug:j.slug,status:j.status,runId:j.runId,investigationDepth:j.investigationDepth}));"
```

Confirm the `689-fix-distribute-adminserver-routes` row is `pending` (or has re-run again since).
Then, **after** the code changes below are in place and their tests are green, flip that row to
`completed` and move its PRD file out of the live dir so the loop cannot re-arm:

```bash
node -e "
const fs=require('fs');
const p='/home/bilko/.claude/session-manager/scheduled-plans/queue.json';
const q=JSON.parse(fs.readFileSync(p,'utf8'));
const j=q.jobs.find(x=>x.slug==='689-fix-distribute-adminserver-routes');
if(!j){console.log('row absent — nothing to reconcile');process.exit(0);}
if(j.status==='running'){console.log('HALT: job is running, do not touch');process.exit(1);}
j.status='completed'; j.exitCode=0; j.error=null;
j.runId=j.runId||'2026-07-31T07-38-29-081Z';
j.finishedAt=j.finishedAt||'2026-07-31T07:39:34.748Z';
const tmp=p+'.tmp'; fs.writeFileSync(tmp,JSON.stringify(q,null,2)); fs.renameSync(tmp,p);
console.log('reconciled 689-fix-distribute-adminserver-routes -> completed');
"
mkdir -p session-manager-operations/scheduler/prds-archived
git mv -k session-manager-operations/scheduler/prds/689-fix-distribute-adminserver-routes.md \
       session-manager-operations/scheduler/prds-archived/ 2>/dev/null \
  || mv session-manager-operations/scheduler/prds/689-fix-distribute-adminserver-routes.md \
        session-manager-operations/scheduler/prds-archived/
ls session-manager-operations/scheduler/prds/ | grep -c 689 || true
```

Note: the app may be running and holding `queue.json`. Writes there go through tmp+rename above,
which matches the repo's atomic-write convention. If the Electron app rewrites the row back to
`pending` afterwards, that is defect (1) still live — finish the code changes and re-run this
reconcile as the **last** step before the gates.

Also archive **this** PRD's own file at the end of the run (see Step 4) so it does not itself
become the next resurrection.

## Step 1 — Make the resurrection guard independent of `history.jsonl` existing

In `src/main/scheduler.cjs`'s `syncPrdsIntoQueue` (the `for (const [slug, p] of onDisk)` loop,
~line 881):

- Keep the existing `historyBySlug` lookup as the primary source.
- Add a **fallback terminal-outcome probe** for unmatched slugs when `historyBySlug` has no
  entry: check `~/.claude/session-manager/scheduled-plans/runs/*/<slug>.meta.json` +
  `<slug>.verdicts.json`. If the most recent run dir for that slug has `meta.json.exitCode === 0`
  and `verdicts.json.verdict` is one of the completed-equivalent verdicts already enumerated at
  `scheduler.cjs` ~line 2203 (`clean`, `pass_no_commit_target_verified`,
  `pass_no_commit_already_shipped`), treat the slug as terminal-completed: push it to
  `historyArchiveCandidates` (so its file gets swept) and `continue` — **do not** create a fresh
  `pending` row.
- Put the probe in a small, pure-ish, unit-testable helper (e.g.
  `src/main/lib/terminalRunOutcome.cjs` exporting
  `latestTerminalOutcomeForSlug(slug, { runsDir, fsImpl })` returning
  `{ status: 'completed'|'failed'|null, runId, finishedAt }`) so the test can point it at a temp
  runs dir rather than the real one. Bound the scan: read the runs directory listing once, filter
  to entries containing `<slug>.meta.json`, and only stat/parse the newest few (sort dir names
  descending — they are ISO timestamps — and take at most 5). The runs dir has 2000+ entries; do
  not stat all of them per slug, and only pay this cost when `unmatchedSlugs.length > 0`.
- Failure-safe: any fs/JSON error → return `null` → current behavior (resurrect) is unchanged.
- Do **not** treat `failed`/`needs_review` outcomes as archivable — mirror the existing comment
  ("`failed` … is left alone entirely: not resurrected, not archived"). Return
  `status: 'failed'` from the helper and `continue` without archiving, matching how a history hit
  with a non-`completed` status is handled today.

While you are in there: also make the queue durably record terminal jobs so this guard has a
real history to read next time. Confirm `queueHistory.appendHistory` is actually reached — if
`history.jsonl` is absent because `partitionJobs` never selects anything (7-day retention, and
jobs[] is large), that is expected and is exactly why the fallback above is needed. **Do not**
shorten `HISTORY_RETENTION_MS`.

## Step 2 — Never spawn an auto-fix investigation for a clean, exit-0 run

In `src/main/scheduler.cjs`, add an early guard inside `spawnInvestigation` (~line 1859), next to
the existing `isFixPlanBeyondDepthCap` early-return, so it holds for **every** call site (the
three at ~2390, ~2396, ~3060):

- Read `<runDir>/<slug>.meta.json` and `<runDir>/<slug>.verdicts.json`.
- If `meta.exitCode === 0` **and** `verdicts.verdict` is `clean` /
  `pass_no_commit_target_verified` / `pass_no_commit_already_shipped`, log one line
  (`[scheduler] skip investigation: <slug> last run verified <verdict> (exit 0) — nothing to
  diagnose`) and return without spawning.
- Any read/parse failure → fall through and spawn (fail-open; never let a missing artifact
  suppress a real investigation).
- Factor the verdict set into a single exported constant (e.g. `COMPLETED_EQUIVALENT_VERDICTS`)
  used by both this guard and the `effectiveStatus` branch at ~line 2203, rather than a third
  hand-copied list.

## Step 3 — Tests

Add focused unit tests. Follow the existing vitest-in-`.cjs` convention used by
`src/main/__tests__/runVerify.test.cjs` and `src/main/__tests__/scheduler-admin-routes.test.cjs`
(ESM `import { test, expect } from 'vitest'` + CommonJS `require` of the module under test), and
**register every new test file in `vitest.config.ts`'s explicit `include` allow-list** — this
repo's `include` is an allow-list, so an unregistered file silently never runs (that exact gap is
what PRD 689's own fix-plan had to repair).

- `src/main/lib/__tests__/terminalRunOutcome.test.cjs`
  - returns `{status:'completed'}` for a temp runs dir whose newest `<slug>` run has
    `exitCode:0` + `verdict:'clean'`
  - same for `pass_no_commit_already_shipped`
  - returns `{status:'failed'}` for `exitCode:1`
  - returns `null` when no run dir, when JSON is malformed, and when the dir is unreadable
  - picks the **newest** run dir when several exist for the slug
  - stats at most the newest few dirs (assert via a counting `fsImpl` stub, so the bound is
    actually enforced and not just intended)
- A scheduler-level test that `spawnInvestigation` (or the extracted guard predicate) declines
  for a clean exit-0 run and proceeds for `exitCode: 1` and for a missing `verdicts.json`.

If `spawnInvestigation` is not directly unit-testable, extract the guard into an exported pure
predicate (e.g. `shouldSkipInvestigationForCleanRun({ meta, verdicts })`) and test that; call it
from `spawnInvestigation`. Do not restructure the spawn machinery beyond that.

## Step 4 — Gates, reconcile, commit

Run in this order, green gate LAST:

```bash
timeout 300 npm run typecheck
timeout 180 npx vitest run src/main/lib/__tests__/terminalRunOutcome.test.cjs
timeout 300 npm run test:unit
```

Then perform the Step 0 reconcile (queue row → completed, PRD file archived), archive **this**
PRD file too:

```bash
mv session-manager-operations/scheduler/prds/689-fix-fix-distribute-adminserver-routes.md \
   session-manager-operations/scheduler/prds-archived/ 2>/dev/null || true
```

Then stage **only** your own files and commit:

```bash
git add src/main/scheduler.cjs src/main/lib/terminalRunOutcome.cjs \
        src/main/lib/__tests__/terminalRunOutcome.test.cjs vitest.config.ts
git add -A session-manager-operations/scheduler/prds session-manager-operations/scheduler/prds-archived
git status --short
```

Do **not** commit `plugins-redesign-full.png`, `prd791-screenshots.mjs`,
`sm-layout-screenshots.mjs`, `tabbar-group-screenshots.mjs`, anything under
`session-manager-operations/feedback/`, or other jobs' PRD files. Never `git add -A` at repo
root.

Finally re-run the green gate so the run ends green:

```bash
timeout 300 npm run test:unit
```

# Verification commands

```bash
cd /home/bilko/Projects/session-manager
timeout 300 npm run typecheck
timeout 300 npm run test:unit
node -e "const q=require('/home/bilko/.claude/session-manager/scheduled-plans/queue.json'); const j=q.jobs.find(x=>x.slug==='689-fix-distribute-adminserver-routes'); console.log(j?j.status:'absent');"
if ls session-manager-operations/scheduler/prds/689-fix-*.md 2>/dev/null; then echo "HALT: 689 fix-plan PRD still live in prds/"; exit 1; fi; echo "clean: no live 689 fix-plan PRD"
git log --oneline -1
git status --short | head -20
```

# Acceptance criteria

- [ ] `src/main/scheduler.cjs`'s `syncPrdsIntoQueue` no longer resurrects an unmatched on-disk
      slug as a fresh `pending` job when the newest run dir for that slug shows `exitCode === 0`
      plus a completed-equivalent verdict — even when `history.jsonl` does not exist. `completed`
      outcomes feed `historyArchiveCandidates`; `failed` outcomes are neither resurrected nor
      archived.
- [ ] The terminal-outcome probe lives in its own module, takes injectable `runsDir`/`fsImpl`,
      fails safe to `null` on any fs/JSON error, scans at most the newest few run dirs for a
      slug, and only runs when there is at least one unmatched slug.
- [ ] `spawnInvestigation` early-returns (with one log line, no Opus spawn) when the run's
      `meta.json` has `exitCode === 0` and `verdicts.json.verdict` is `clean`,
      `pass_no_commit_target_verified`, or `pass_no_commit_already_shipped`; it still spawns on
      any read/parse failure. The guard is in `spawnInvestigation` itself, so all call sites are
      covered.
- [ ] The completed-equivalent verdict list is a single shared constant, not a third hand-copied
      literal.
- [ ] New tests exist, are listed in `vitest.config.ts`'s `include`, and pass under
      `npm run test:unit`: newest-run selection, `clean` / `pass_no_commit_already_shipped` →
      completed, `exitCode:1` → failed, missing/malformed/unreadable → null, stat-count bound,
      and the investigation guard (skips on clean exit-0, proceeds on exit-1 and on missing
      verdicts).
- [ ] `queue.json`'s `689-fix-distribute-adminserver-routes` row is `completed` (not `pending`),
      and no `689-fix-*.md` remains in `session-manager-operations/scheduler/prds/`.
- [ ] No file under `src/main/lib/localAdminHttp.cjs`, the admin routes in
      `src/main/scheduler.cjs`, `src/main/lib/prdCreate.cjs`, `scripts/scheduler-mcp-server.cjs`,
      or `.mcp.json` was modified for adminServer reasons — PRD 689's deliverable is already
      shipped and must be left alone.
- [ ] `timeout 300 npm run typecheck` passes.
- [ ] `timeout 300 npm run test:unit` passes and is the LAST command of the run.
- [ ] The work is **committed** (only the files listed in Step 4) and the run ends with
      `SCHEDULER_VERDICT: PASS` as the literal last line.

# Out of scope

- Re-doing, re-verifying, or modifying the adminServer → `localAdminHttp` split (already shipped
  in `cf0e51a` / `b1547b0` / `1f89ee9`).
- `runVerify.cjs`'s `pass_no_commit` exemption logic and `resetJobFields`' terminal-status guard —
  both owned by queued PRD `817-verifier-exempt-already-landed-slug-reruns`.
- Changing `HISTORY_RETENTION_MS`, the auto-archive retention policy, or `queueHistory.cjs`'s
  partitioning.
- Bulk-archiving other stale PRD files, triaging other slugs' queue rows, or committing anything
  under `session-manager-operations/feedback/`.
- Any UI/renderer change.

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

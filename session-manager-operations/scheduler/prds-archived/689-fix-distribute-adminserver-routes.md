---
title: "Fix: commit the already-complete adminServer split (689) and wire its tests into vitest"
cwd: /home/bilko/Projects/session-manager
parallelGroup: 689
estimateMinutes: 25
---

# Goal

Recover and land the work of PRD `689-distribute-adminserver-routes`, which **already
implemented its entire acceptance checklist** but died before committing.

**Read this first: the work is very likely already sitting uncommitted in your working tree.**
Your job is NOT to redo the refactor from scratch. It is to (1) verify what is on disk, (2)
finish the small remaining gaps, (3) run the gates, (4) **commit**, and (5) emit the verdict
sentinel.

# Root-cause analysis (what went wrong)

The original run (`runs/2026-07-27T03-27-23-118Z/689-distribute-adminserver-routes.log`) did all
of this successfully:

- Created `src/main/lib/localAdminHttp.cjs` — the generic loopback transport
  (`timingSafeEqualStrings`, `readBody`, `sendJson`, `TOKEN_PATH`/`ensureToken`/`persistPort`/
  `authorized`, `createAdminHttp()` returning `{ start, stop, registerRoute }` with a
  `${method} ${url}` dispatch map + 404 fallback).
- Added `registerAdminRoutes(adminHttp, remoteObj = remote)` to `src/main/scheduler.cjs`
  (`GET /admin/scheduler/jobs`, `POST /admin/scheduler/reset-job`) and exported it.
- Added `registerAdminRoute(adminHttp, remote)` to `src/main/lib/prdCreate.cjs`
  (`POST /admin/scheduler/create-prd`) and exported it.
- Rewired `src/main/index.cjs` to `createAdminHttp()` + the two registration calls, and renamed
  the `adminServer.start()` / `.stop()` call sites to `adminHttp.start()` / `.stop()`.
- Deleted `src/main/adminServer.cjs` and `src/main/__tests__/adminServer.test.cjs`, after
  confirming no remaining importers.
- Split the old adminServer tests into `src/main/lib/__tests__/localAdminHttp.test.cjs`,
  `src/main/__tests__/scheduler-admin-routes.test.cjs`, and additions to
  `src/main/__tests__/prdCreate.test.cjs`.
- Ran `timeout 300 npm run typecheck` — **green**. Ran the moved tests — **23 passing**.

It then began a self-review pass and the `claude -p` stream died with
`API Error: Connection closed mid-response` (`terminal_reason: "api_error"`, exit code 1). That
is an upstream transport failure, **not** a defect in the code and **not** a self-delegation
failure (no `Skill` / `/develop` / `ScheduleWakeup` calls appear anywhere in the log). Because
the stream died before the finish protocol, there was **no commit and no
`SCHEDULER_VERDICT` sentinel** — so the job was recorded as failed even though the deliverable
exists on disk.

Two real, small defects were left behind and must be fixed here:

1. **The new/moved test files are `node:test` files that vitest never runs.**
   `vitest.config.ts` uses an *explicit allow-list* `include` array. Neither
   `src/main/lib/__tests__/localAdminHttp.test.cjs`, nor
   `src/main/__tests__/scheduler-admin-routes.test.cjs`, nor
   `src/main/__tests__/prdCreate.test.cjs` is listed, so the original PRD's stated gate
   (`npx vitest run <touched files>`) could never actually have executed them — it reports "no
   test files found". (The pre-existing `adminServer.test.cjs` had the same gap, so coverage was
   not lost by the split, but the gate was vacuous.) `CLAUDE.md` states this repo does not use
   `node --test`, and vitest is the project gate — so these must be reachable from
   `npm run test:unit`.
2. **Comments credit the wrong PRD number.** Several new/edited comment blocks in
   `scheduler.cjs`, `lib/prdCreate.cjs`, and the new test files say "PRD 688" when this work is
   PRD 689.

# Fix steps

## Step 0 — Establish what is actually on disk (do this before editing anything)

```bash
cd /home/bilko/Projects/session-manager
git status --short
git stash list
git diff --stat
```

Expect (roughly):

```
 D src/main/__tests__/adminServer.test.cjs
 M src/main/__tests__/prdCreate.test.cjs
 D src/main/adminServer.cjs
 M src/main/index.cjs
 M src/main/lib/prdCreate.cjs
 M src/main/scheduler.cjs
?? src/main/__tests__/scheduler-admin-routes.test.cjs
?? src/main/lib/__tests__/localAdminHttp.test.cjs
?? src/main/lib/localAdminHttp.cjs
```

- **If those changes are present:** they are PRD 689's work. Do NOT stash, reset, or discard
  them. Proceed to Step 1.
- **If they are absent** (someone committed or reverted them): check
  `git log --oneline -10` for an existing commit that already landed this split. If it landed,
  skip to Step 3 and only apply the vitest-registration fix. If it is genuinely gone, implement
  the refactor described in "Root-cause analysis" above from scratch — the bullets there are a
  complete spec.

Other files may also be dirty (`src/main/templates/PRD_AUTHORING.md`, files under
`session-manager-operations/feedback/`). Those belong to **other** jobs — **do not commit them,
do not stash them, do not revert them.** Stage only the files listed above (`git add` them
explicitly by path; never `git add -A`).

## Step 1 — Read and sanity-check the moved code

Read, in full:

- `src/main/lib/localAdminHttp.cjs`
- the `registerAdminRoutes` function + `module.exports` line near the bottom of
  `src/main/scheduler.cjs`
- the `registerAdminRoute` function in `src/main/lib/prdCreate.cjs`
- the `createAdminHttp` / `registerAdminRoutes` / `registerAdminRoute` / `adminHttp.start()` /
  `adminHttp.stop()` sites in `src/main/index.cjs`

Confirm the security posture survived the move — this is the one thing that must not have
regressed:

- server binds `127.0.0.1` only, OS-assigned port (`listen(0, '127.0.0.1')`)
- token file `~/.claude/session-manager/admin-api.json` written with mode `0600`
- token comparison via `crypto.timingSafeEqual`
- unauthorized requests rejected before dispatch; unknown `${method} ${url}` → 404
- the three route URLs, request bodies and response JSON shapes are byte-identical to what
  `git show HEAD:src/main/adminServer.cjs` had

If any of those regressed, fix it verbatim against `git show HEAD:src/main/adminServer.cjs`.

Then confirm nothing still imports the deleted module (note the inverted exit — a bare `grep`
exits 1 on no-match, which would surface as a failure):

```bash
if grep -rn "adminServer" src/ scripts/ bin/ .mcp.json --include='*.cjs' --include='*.ts' --include='*.tsx' --include='*.json' 2>/dev/null; then echo "HALT: lingering adminServer references above"; exit 1; fi; echo "clean: no adminServer references"
```

Also read `scripts/scheduler-mcp-server.cjs` and confirm it only speaks to the routes over
HTTP by URL + token (it must need no change). Do not modify it or `.mcp.json`.

## Step 2 — Fix the PRD-number attribution

In `src/main/scheduler.cjs`, `src/main/lib/prdCreate.cjs`,
`src/main/lib/__tests__/localAdminHttp.test.cjs`,
`src/main/__tests__/scheduler-admin-routes.test.cjs` and
`src/main/__tests__/prdCreate.test.cjs`, replace comment references to `PRD 688` that describe
*this* adminServer split with `PRD 689`. Only touch comments that describe the split; leave any
genuine pre-existing PRD-688 references alone.

## Step 3 — Make the moved tests actually run under vitest

`vitest.config.ts`'s `test.include` is an explicit allow-list. Add the three files so
`npm run test:unit` covers them:

```
'src/main/__tests__/prdCreate.test.cjs',
'src/main/__tests__/scheduler-admin-routes.test.cjs',
'src/main/lib/__tests__/localAdminHttp.test.cjs',
```

Then convert those three files' test harness imports from `node:test` to vitest, matching the
convention already used by the files vitest does run (e.g. read
`src/main/__tests__/scheduler-effective-concurrency.test.cjs` and
`src/main/__tests__/classifyTranscriptLine.test.cjs` first and copy their style exactly):

- replace `const { test } = require('node:test');` with
  `import { test, expect } from 'vitest';`
- replace `const assert = require('node:assert/strict');` and rewrite the assertions as
  `expect(...)` calls (`assert.equal` → `expect(x).toBe(y)`,
  `assert.deepEqual` → `expect(x).toEqual(y)`, `assert.ok` → `expect(x).toBeTruthy()`,
  `assert.match` → `expect(x).toMatch(re)`, `assert.rejects` → `await expect(p).rejects.toThrow()`)
- keep every remaining `require(...)` of project modules as-is (these files stay `.cjs`; the
  other vitest-run `.cjs` tests in this repo already mix an ESM `import` of vitest with CommonJS
  `require` of the code under test — follow that same pattern)
- update the `Run:` line in each file's header comment from `node --test` to
  `timeout 120 npx vitest run <path>`

**Do not delete or weaken any test case.** Every assertion that exists today must still exist
after the conversion — this is a harness swap, not a rewrite. Count the test cases before and
after and confirm they match.

## Step 4 — Gates, then commit

Run, in this order, with the green gate LAST:

```bash
timeout 300 npm run typecheck
timeout 180 npx vitest run src/main/lib/__tests__/localAdminHttp.test.cjs src/main/__tests__/scheduler-admin-routes.test.cjs src/main/__tests__/prdCreate.test.cjs
timeout 300 npm run test:unit
```

All three must be green. If `npm run test:unit` surfaces a pre-existing failure unrelated to the
admin-route files, print one line naming it, confirm it also fails on `git stash`-free `HEAD`
state reasoning, and do not let it block — but the three admin files themselves must pass.

Then stage **only** the 689 files and commit:

```bash
git add src/main/lib/localAdminHttp.cjs \
        src/main/lib/__tests__/localAdminHttp.test.cjs \
        src/main/__tests__/scheduler-admin-routes.test.cjs \
        src/main/__tests__/prdCreate.test.cjs \
        src/main/lib/prdCreate.cjs \
        src/main/scheduler.cjs \
        src/main/index.cjs \
        vitest.config.ts
git rm --cached -q src/main/adminServer.cjs src/main/__tests__/adminServer.test.cjs 2>/dev/null || true
git add -u src/main/adminServer.cjs src/main/__tests__/adminServer.test.cjs
git status --short
```

Verify with `git status --short` that `src/main/templates/PRD_AUTHORING.md` and anything under
`session-manager-operations/` remain **unstaged**, then commit with a message describing the
split (PRD 689).

# Verification commands

```bash
timeout 300 npm run typecheck
timeout 180 npx vitest run src/main/lib/__tests__/localAdminHttp.test.cjs src/main/__tests__/scheduler-admin-routes.test.cjs src/main/__tests__/prdCreate.test.cjs
timeout 300 npm run test:unit
if grep -rn "adminServer" src/ scripts/ bin/ .mcp.json 2>/dev/null; then echo "HALT: lingering adminServer references"; exit 1; fi; echo clean
git log --oneline -1
git status --short
```

# Acceptance criteria

- [ ] `src/main/adminServer.cjs` and `src/main/__tests__/adminServer.test.cjs` no longer exist;
      no file in `src/`, `scripts/`, `bin/`, or `.mcp.json` references `adminServer`.
- [ ] `src/main/lib/localAdminHttp.cjs` exists and exports `createAdminHttp` returning
      `{ start, stop, registerRoute }`, with the original security posture intact:
      127.0.0.1-only bind, OS-assigned port, 0600 token file at
      `~/.claude/session-manager/admin-api.json`, `crypto.timingSafeEqual` comparison,
      authorize-then-dispatch, 404 on unknown `${method} ${url}`.
- [ ] `scheduler.cjs` exports `registerAdminRoutes` (registering `GET /admin/scheduler/jobs`
      and `POST /admin/scheduler/reset-job`); `lib/prdCreate.cjs` exports `registerAdminRoute`
      (registering `POST /admin/scheduler/create-prd`). Both take the transport (and `remote`)
      as explicit parameters.
- [ ] `src/main/index.cjs` calls `createAdminHttp()`, both registration functions, and
      `adminHttp.start()` / `adminHttp.stop()` at the original call sites.
- [ ] All three route URLs, request payloads and response JSON shapes are unchanged from
      `git show HEAD:src/main/adminServer.cjs`; `scripts/scheduler-mcp-server.cjs` and
      `.mcp.json` are untouched.
- [ ] Comments describing this split say PRD 689, not PRD 688.
- [ ] `vitest.config.ts`'s `include` lists `src/main/__tests__/prdCreate.test.cjs`,
      `src/main/__tests__/scheduler-admin-routes.test.cjs`, and
      `src/main/lib/__tests__/localAdminHttp.test.cjs`, and all three run (and pass) under
      `npm run test:unit` — no `node:test` imports remain in them.
- [ ] No test case was lost in the `node:test` → vitest conversion.
- [ ] `timeout 300 npm run typecheck` passes.
- [ ] `timeout 300 npm run test:unit` passes.
- [ ] The work is **committed** (only the 689 files; `PRD_AUTHORING.md` and
      `session-manager-operations/**` left uncommitted) and the run ends with
      `SCHEDULER_VERDICT: PASS` as the literal last line.

# Out of scope

- Changing route URLs, request/response shapes, or the auth mechanism.
- Touching `scripts/scheduler-mcp-server.cjs` or `.mcp.json`.
- Adding a 4th admin route or any capability beyond what `adminServer.cjs` had.
- Committing, reverting, or stashing `src/main/templates/PRD_AUTHORING.md` or anything under
  `session-manager-operations/` — those belong to other jobs.
- Any non-admin-route logic in `scheduler.cjs` or `lib/prdCreate.cjs`.

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

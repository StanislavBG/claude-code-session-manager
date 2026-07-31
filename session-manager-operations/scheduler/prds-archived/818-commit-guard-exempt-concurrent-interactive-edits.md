---
title: Commit-guard false-flags a legitimate no-op job when an interactive session concurrently edits the same repo
cwd: ~/Projects/session-manager
estimateMinutes: 20
---

# Goal

`src/main/scheduler.cjs`'s commit-guard (around line 2101-2148, "Commit guard: a clean exit that
left NEW uncommitted changes...") already has two false-positive defenses: a baseline-delta
(only files dirtied during this run count) and a sibling-scheduler-job skip
(`siblingRunning` — another `status === 'running'` job on the same cwd) plus a
self-commit skip (`jobSelfCommitted` — HEAD moved during the run). Both defenses assume the only
concurrent writer to the repo is another scheduler job. They miss a third, now-confirmed-live
case: an **interactive `claude` session** (e.g. `/process-feedback` or `/develop` running in the
main loop) writing files into the same shared repo — such as authoring new PRD `.md` files —
while a scheduler job that made a legitimate no-op decision (its own AC was already satisfied by
an earlier run, so it correctly committed nothing) is finishing up. Because that job made no
commit of its own (`jobSelfCommitted` is false) and no *scheduler* job was running concurrently
(`siblingRunning` is false), the guard has no exemption and flags the honest no-op job
`uncommitted_changes` → `needs_review`, blaming it for files it never touched.

Confirmed live incidents from the same 2026-07-31 07:3x PDT window: job
`655-needs-review-rca-feedback-hook` was flagged for
`session-manager-operations/scheduler/prds/816-vitest-register-runverify-test.md`, and job
`672-fix-feedback-session-manager` was flagged for three files under
`session-manager-operations/feedback/processed/` and `session-manager-operations/scheduler/prds/`
— all of which were written by a concurrently-running `/process-feedback` pass in the main
interactive session, not by either flagged job. The code's own comment already anticipates this
("leftover dirt is presumptively a concurrent external edit (e.g. an interactive session editing
the same repo)") but the exemption logic only covers it when the job itself also committed
(`jobSelfCommitted`), which a legitimate no-op job never does.

# Acceptance criteria

- [ ] The commit-guard gains a way to attribute newly-dirty files to files the failing job's own
      `git diff`/working tree actually plausibly touched, OR (simpler, prefer this if it fits the
      existing shape) extend the exemption so a job that printed a truthful `SCHEDULER_VERDICT:
      PASS` with **no commit** and **no new work required** (i.e. it hit the same
      "already-landed" no-op path PRD 817 addresses) is not additionally penalized by the
      commit-guard for dirt it didn't create — the two checks should not double-punish the same
      legitimate no-op outcome from two different code paths.
- [ ] Alternatively/additionally: detect "interactive session activity" as a skip condition
      analogous to `siblingRunning` — e.g. check for a live `claude` process with a session
      lockfile/heartbeat distinct from scheduler-spawned jobs, OR narrow the newly-dirty check to
      only files under paths the job's own transcript shows it wrote to (requires log parsing —
      only pursue this if the simpler PASS+no-required-work exemption above doesn't fully cover
      the confirmed incidents). Pick whichever approach is a smaller, more surgical diff given
      what you find reading the surrounding code — don't over-engineer a general "who wrote this
      file" attribution system for a narrow false-positive.
- [ ] Add a unit test in `src/main/__tests__/` reproducing at least one of the two confirmed
      incidents: job exits 0, PASS sentinel, no commit, but `newlyDirty` contains a file the job
      never referenced (e.g. by simulating a concurrent write between baseline and after-snapshot)
      → guard does NOT flag `uncommitted_changes` when the job's own verdict was a legitimate
      no-op resolution.
- [ ] Existing commit-guard behavior for a REAL leftover-work case (job did NOT reach a legitimate
      no-op verdict, made no commit, left files dirty, no sibling/interactive activity) must still
      flag `uncommitted_changes` — do not weaken the guard for genuine finish-protocol violations.
- [ ] `timeout 300 npm run typecheck` passes
- [ ] `timeout 300 npm run test:unit` passes including the new test

# Implementation notes

Read `src/main/scheduler.cjs` around line 2101-2148 (the commit-guard block quoted in the Goal
above) and its sibling occurrence around line 2320-2345 (`newlyDirtyCount`, used by
`classifyFailureOutcome`) — both derive from the same `uncommittedChanges(guardCwd)` /
baseline-delta pattern; check whether a fix needs to touch one or both sites. This PRD is
deliberately scoped separately from
`session-manager-operations/scheduler/prds/817-verifier-exempt-already-landed-slug-reruns.md`
(filed the same pass): PRD 817 fixes `runVerify.cjs`'s `pass_no_commit` verdict path; this PRD
fixes the commit-guard, a structurally different check in `scheduler.cjs` that can fire even when
`runVerify.cjs` would have correctly exempted the run. They may end up sharing a small helper
(e.g. "did this run's own verdict indicate a legitimate no-op") — if so, extract it once and call
it from both, per the API-reuse standard, rather than duplicating the logic.

## Engineering standards

Before writing any code, read
`/home/bilko/Projects/session-manager/plugins/session-manager-dev/skills/develop/standards.md`
— it has the Performance, Debugging, API-reuse, TDD, and Execution-discipline rules that apply
to this PRD. Every rule in it is mandatory, especially Execution discipline (bounded commands,
verify before done, the finish-protocol sentinel).

# Out of scope

- Do not build a general file-attribution/audit-trail system — keep the fix narrow to the
  confirmed no-op-job false-positive case
- Do not touch PRD 817's `pass_no_commit` exemption logic in `runVerify.cjs` — that's a separate
  PRD; share a helper only if it emerges naturally, don't force it

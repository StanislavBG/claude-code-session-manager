---
title: Drop `git add -A` from the finish protocol — it sweeps concurrent jobs' work into the wrong commit
cwd: /home/bilko/Projects/session-manager
estimateMinutes: 30
sourcePromptId: not-enough-paralell-processing-why-i-never-see-3-6a96029e
---
# Goal

The scheduler finish protocol instructs every job to run `git add -A && git commit` (scheduler.cjs:198, restated in lib/rcaReport.cjs:84). That was safe when one job ran per project. It is not safe now that the queue can run several jobs in one working tree: whichever job commits first sweeps every sibling's in-flight edits into its own commit, mis-attributing the work and making both jobs' verdicts unreliable. Observed twice on 2026-08-02: a commit had to be hand-staged to six explicit paths to avoid capturing a concurrent job's half-written renderer files, and PRD 986's implementation was found sitting uncommitted in the tree while 986 was already archived `completed`. Replace the blanket add with explicit staging of the files the job actually changed.

# Acceptance criteria

- [ ] `FINISH_PROTOCOL` (src/main/scheduler.cjs:~198) no longer tells the executor to run `git add -A`. It instructs explicit staging of the paths the job itself created or modified, e.g. `git add <path> [<path>...] && git commit -m "..."`.
- [ ] The identical instruction in `src/main/lib/rcaReport.cjs:~84` is updated in the same commit so the two copies cannot drift — grep for `git add -A` across src/ and confirm zero remaining occurrences in executor-facing instruction text.
- [ ] The protocol text explicitly warns that other jobs may be editing the same working tree concurrently, and that staging a path the job did not touch mis-attributes another job's work.
- [ ] The protocol keeps its existing hard requirement that a job must not end with ITS OWN work uncommitted — the change is which paths get staged, never whether to commit.
- [ ] A unit test asserts the FINISH_PROTOCOL string contains no `add -A` / `add .` / `add --all` form. This is a cheap guard against the instruction being reintroduced by a later edit.
- [ ] `npm run typecheck` and `npm run test:unit` pass.

# Implementation notes

This is a narrow, text-and-test-only change to executor-facing instructions. It is the one non-redundant piece of the retired PRD 993 — 993's other half (per-job commit attribution) already shipped in PRD 983 as the per-job `landedCommit` signal (see `healRefusalReason`, scheduler.cjs:~3796), and its remaining half is covered by PRD 996.

Do NOT touch `commitGuardVerdict`, `siblingRunning`, `committedInWindow` or `landedCommit` in this PRD. PRD 996 is concurrently reworking that guard and deliberately PRESERVES the sibling-running skip on the grounds that a concurrent job makes working-tree evidence unreliable in both directions. Editing the same code here would collide with it.

The uncommitted-changes check in `commitGuardVerdict` computes `newlyDirty` as a DELTA against a pre-run baseline, so it already tolerates files this job did not touch. Explicit staging is therefore consistent with the guard as it stands — no guard change is required to make this land.

Read the engineering standards file before writing code.

# Out of scope

- Any change to commitGuardVerdict / siblingRunning / committedInWindow (PRD 996 owns those)
- Worktree isolation (separate PRD)
- Changing the verdict sentinel protocol

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).

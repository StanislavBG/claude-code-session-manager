---
title: Attribute commits to the job that made them — parallelism just blinded the commit guard
cwd: /home/bilko/Projects/session-manager
estimateMinutes: 55
sourcePromptId: not-enough-paralell-processing-why-i-never-see-3-6a96029e
---
# Goal

The commit guard's three signals are all cwd-global and were written when at most one job ran per project. Raising real concurrency to 4-5 breaks every one of them. `committedInWindow` (scheduler.cjs:291) runs `git log --all --since --until` on the shared cwd, so ANY sibling's commit in the window counts as this job's. `jobSelfCommitted` (scheduler.cjs:2967) is `guardHeadAfter !== guardHeadBefore`, and a sibling's commit moves HEAD too. `siblingRunning` (scheduler.cjs:2963) suppresses the uncommitted-changes downgrade whenever any other job runs in the same cwd — at 4-wide that is nearly always true, so `commitGuardVerdict` returns null and the guard is effectively OFF while the queue is busy. Net effect: a job that ships zero code can be certified by a sibling's commit. That is precisely the PRD 972 failure this project already has PRDs 985/986/987 open about, and parallelism widens it from a rare race into the default case.

# Acceptance criteria

- [ ] `committedInWindow` is replaced by (or gains) job-scoped attribution: a commit counts for a job only if it is attributable to that job, not merely coincident in time on the shared cwd.
- [ ] The attribution mechanism is explicit and recorded, not inferred from timing. Preferred: the finish protocol's commit carries a trailer naming the job slug (e.g. `Scheduler-Job: <slug>`), and the guard greps `git log --format=%H %(trailers)` for it. If the executor chooses a different mechanism, it must state why in a code comment and must NOT be time-window-based.
- [ ] `FINISH_PROTOCOL` (scheduler.cjs:198) instructs the executor to include that trailer in its commit message, and the identical instruction in `lib/rcaReport.cjs:84` is updated in the same change so the two never drift.
- [ ] `jobSelfCommitted` no longer keys on a bare HEAD move. It is true only when a commit attributable to THIS job exists.
- [ ] `siblingRunning` stops being a blanket suppressor of the uncommitted-changes downgrade. Replace it with a check scoped to the dirty FILES: the downgrade is suppressed only for paths a sibling job plausibly touched, not for the whole verdict. A job leaving its OWN files dirty must still be downgraded even while siblings run.
- [ ] `git add -A` is removed from the finish protocol instruction. With N jobs in one tree it sweeps siblings' in-flight edits into this job's commit — observed live on 2026-08-02, when a manual commit had to be hand-staged to 6 files to avoid capturing a concurrent job's half-written renderer work. Replace with explicit staging of the files the job actually changed.
- [ ] A unit test asserts a sibling's commit inside the run window does NOT satisfy the guard for a job that committed nothing.
- [ ] A unit test asserts a job's own trailer-tagged commit DOES satisfy the guard even when siblings also committed in the same window.
- [ ] A unit test asserts `commitGuardVerdict` still downgrades a job that left its own files dirty while a sibling was running.
- [ ] Existing commit-guard tests (`src/main/__tests__/runVerify.test.cjs`, `scheduler-meta-code-sha.test.cjs` and any commitGuardVerdict specs) are updated to the new contract with comments explaining the concurrency rationale — not deleted.
- [ ] `npm run typecheck` and `npm run test:unit` pass.

# Implementation notes

Read these exact sites before changing anything: `committedInWindow` (src/main/scheduler.cjs:291), `computeCommittedDuringRun`, `commitGuardVerdict` (:2105), its call site (:2960-2975), `FINISH_PROTOCOL` (:198), and `src/main/lib/rcaReport.cjs:84`.

The existing comments at scheduler.cjs:286-320 document two real incidents where the guard produced FALSE NEGATIVES (a worktree commit invisible at process exit — `pass-no-commit-worktree-commit-invisible-at-exit`, RCA 770-pr269) and the retry that fixes them. Do not regress that: the retry-once-after-delay behaviour must survive. This PRD is about false POSITIVES (a sibling's commit certifying an empty job), which is the opposite failure and needs a different signal, not a tighter time window.

`fetchAllRefs` + `git log --all` exist so a commit pushed from a removed linked worktree is still visible. A trailer-based grep keeps that property — the trailer travels with the commit object regardless of which worktree authored it — which is also why it composes with the worktree-isolation PRD that depends on this one.

Note the guard already has a `legitimateNoOp` path for jobs that correctly do nothing. Do not make an honest no-op harder to express; the goal is that a no-op can no longer be MISTAKEN for real work.

Read the engineering standards file before writing code.

# Out of scope

- Worktree isolation (separate PRD, depends on this one)
- Changing the verdict sentinel protocol itself
- Reworking the needs_review / RCA reporting flow

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).

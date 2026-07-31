---
title: "Live commit-guard: retry committedInWindow once before downgrading to pass_no_commit"
cwd: ~/Projects/session-manager
parallelGroup: 812
estimateMinutes: 15
---

# Goal

`computeCommittedDuringRun()` (`src/main/scheduler.cjs:264-267`) is called once, immediately at
process exit, to decide whether a job's commit landed. Two independent incidents (feedback
`2026-07-30-pass-no-commit-worktree-commit-invisible-at-exit.md` and RCA
`2026-07-30-rca-770-pr269-search-rank-fts5-fix-20260730T220.md`) show the same root cause: when a
job does its git work in a throwaway linked worktree (the documented shared-repo-safety pattern)
and removes the worktree before exiting, the commit is real and pushed, but `committedInWindow()`
(`scheduler.cjs:243-257`, which does `fetchAllRefs` then `git log --all --since --until`) can race
against ref/object visibility at the exact moment it's called and return `false`. Replaying the
identical `committedInWindow()` call moments later returns `true` and finds the commit. The job is
then wrongly downgraded to `needs_review` with verdict `pass_no_commit`, costing a full RCA +
Opus-investigation + auto-fix-PRD cycle to self-heal (confirmed for `770-pr269-search-rank-fts5-fix`:
the auto-generated `770-fix-pr269-search-rank-fts5-fix` PRD already ran and scanned clean, proving
the fix work was a no-op — the original run's commit was fine all along).

Add one bounded retry to the live commit-guard path so this class of false `pass_no_commit` never
reaches `needs_review` in the first place.

# Acceptance criteria

- [ ] In `computeCommittedDuringRun()` (`src/main/scheduler.cjs:264-267`), when the HEAD-diff fast
  path is false AND the first `committedInWindow()` call also returns `false`, wait a short bounded
  delay (2000ms) and call `committedInWindow()` exactly once more before returning `false`. If
  either call returns `true`, return `true` immediately (no need to wait out the delay if the fast
  path or first attempt already succeeded).
- [ ] The added delay only fires on the negative path (both signals already say "no commit") — a
  job that already shows `headBefore !== headAfter` or whose first `committedInWindow()` call
  returns `true` is unaffected and pays no extra latency.
- [ ] `committedInWindow()` itself is unchanged (still calls `fetchAllRefs` + `git log --all`) —
  reuse it as-is for both the first and retried call, do not fork a second implementation.
- [ ] Add a unit test in `src/main/__tests__/scheduler-committed-in-window.test.cjs` (existing file,
  extend it) asserting: `computeCommittedDuringRun()` returns `true` when a mocked
  `committedInWindow` returns `false` on first call and `true` on the retry; returns `false` when
  both calls return `false`; does not invoke the retry (or the delay) when the HEAD-diff fast path
  already resolves `true`.
- [ ] `timeout 300 npm run typecheck` passes
- [ ] `timeout 120 npx vitest run src/main/__tests__/scheduler-committed-in-window.test.cjs` passes

# Implementation notes

Read `src/main/scheduler.cjs:223-267` first — `fetchAllRefs`, `committedInWindow`,
`computeCommittedDuringRun` are all adjacent. `computeCommittedDuringRun` is called at
`scheduler.cjs:2038` (right after job exit, before `verifyRun`) and again at `scheduler.cjs:2126`
(sigterm path) — both call sites get the retry for free since it lives inside the shared helper;
don't duplicate the retry logic at either call site.

Use a plain `await new Promise(r => setTimeout(r, 2000))` for the delay — no new dependency. Keep
the function's existing "never throws" contract (`committedInWindow` already resolves `false` on
git error, never rejects).

Do not touch `reverifyNeedsReview`'s existing retroactive re-check (`scheduler.cjs:2884`,
`RESCANNABLE_VERDICTS` at `scheduler.cjs:2733`) — that's the async self-heal safety net for
whatever this live-path retry still misses; this PRD narrows how often that safety net has to fire,
it doesn't replace it.

## Engineering standards

Before writing any code, read
`/home/bilko/Projects/session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it
has the Performance, Debugging, API-reuse, TDD, and Execution-discipline rules that apply to this
PRD. Every rule in it is mandatory, especially Execution discipline (bounded commands, verify
before done, the finish-protocol sentinel).

# Out of scope

- Changing `reverifyNeedsReview`'s retroactive re-check or `RESCANNABLE_VERDICTS`
- The cross-branch fallback already shipped by PRD 674 (`gitHead()` vs `committedInWindow()`) — this
  PRD only adds a retry, not a new detection signal
- Any change to `fetchAllRefs`'s own timeout/behavior

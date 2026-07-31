## pass_no_commit false negative: worktree commit invisible at process exit

Job `770-pr269-search-rank-fts5-fix`, run dir
`~/.claude/session-manager/scheduled-plans/runs/2026-07-30T22-06-53-551Z/`. Verdict written:
`{"verdict":"pass_no_commit","reason":"SCHEDULER_VERDICT: PASS but no commit landed during the run window — the run claims success but produced no code change","downgradeTo":"needs_review"}`.

The run's `cwd` (`/home/bilko/Projects/sigma`) was on `docs/methodology-dashboards` with unrelated
uncommitted user WIP, so per the shared-repo rule the executor correctly did all git work in a
throwaway linked worktree at `/tmp/sigma-pr269`, and removed it with `git worktree remove --force`
before exiting. The real commit `fc94c2e187ec495195a203bfbd916b64862e8220` landed and was pushed to
`StanislavBG/sigma-pr:fix/search-ranking-exact-vs-blob-25` (confirmed as PR #269's current head,
`mergeable: MERGEABLE`, CI green). But `cwd`'s HEAD never moved (`headBefore === headAfter`), so
`computeCommittedDuringRun()` fell through to `committedInWindow()`, which returned false at
process-exit time.

Replaying `committedInWindow('/home/bilko/Projects/sigma', <startedAt>, <finishedAt>)` after the
fact returns **true** and finds `fc94c2e` — so this is a timing/ref-visibility fragility in the
guard (the worktree's objects/refs may not yet be fully visible/GC'd-in at the exact moment the
guard runs), not a missing commit.

Suggested hardening: re-run the window scan once after a short delay before downgrading to
`needs_review` (or have `reverifyNeedsReview` clear `pass_no_commit` the same way it already clears
`no_verdict_sentinel`).

Cross-reference: `processed/2026-07-22-pass-no-commit-false-negative-on-branch-hopping-prd.md` —
same failure class, different trigger (branch-hopping vs. worktree-based execution).

## RESOLUTION

**Queued as `812-commit-guard-retry-on-worktree-ref-visibility-delay`** (this repo's own
`session-manager-operations/scheduler/prds/`) — adds one bounded 2s retry of
`committedInWindow()` inside `computeCommittedDuringRun()` (`scheduler.cjs:264-267`) before the
live commit-guard downgrades to `pass_no_commit`, per the suggested hardening. Merged with the
sibling RCA item `2026-07-30-rca-770-pr269-search-rank-fts5-fix-20260730T220.md`, which is the
concrete instance that produced this exact evidence — same PRD covers both. The `770` instance
itself is already self-healed (its auto-generated `770-fix-pr269-search-rank-fts5-fix` ran and
scanned `clean` — confirming the original commit was fine and no repo-side fix was needed), so this
PRD is scoped to the systemic timing fix only, not a per-instance repair.

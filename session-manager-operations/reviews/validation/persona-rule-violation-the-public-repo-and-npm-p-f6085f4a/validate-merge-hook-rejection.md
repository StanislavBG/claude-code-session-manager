# Validation: merge-hook-rejection-failure-kind (PRD 2384)

Base: 043d76f7. Commit under review: a48396a4 (only commit in `043d76f7..HEAD` touching the PRD's files; 3 files, +44/-6).

## 2384-merge-hook-rejection-failure-kind — VERIFIED (with one Important follow-up)

| Criterion | Evidence |
| --- | --- |
| classifyMergeFailure returns `hook_rejected` on `identity-guard:`, after blocking_paths, before CONFLICT | `src/main/lib/git/gitWorktree.cjs:1011-1016` — blocking check, then the `identity-guard:` test over stdout+stderr, then the `CONFLICT (` test |
| Both merge-failure returns use `merge blocked by a git hook: ` only for hook_rejected; other kinds unchanged | New helper `mergeFailureReason` (`gitWorktree.cjs:1029-1033`) returns the old string `merge failed (likely a real content conflict): ${text}` for every other kind; used at both returns (diff hunks at ~1486 and ~1519) |
| Pure-addition commit path no longer drops a hook rejection | `gitWorktree.cjs` catch (`autoErr`) joins stderr/stdout/message, and on `identity-guard:` runs `merge --abort` and returns `failureKind: 'hook_rejected'` with that text; otherwise falls through as before |
| isMechanicalRecoveryFutile true for hook_rejected under same base-HEAD condition | `src/main/scheduler/reviewLadder.cjs:~101` — `content_conflict \|\| hook_rejected` plus the same `integrationBaseHeadSha`/`currentHeadSha` equality |
| Real-temp-repo commit-msg hook test + futile-rule test | `gitWorktreeIntegrateSha.test.cjs:81-101` — asserts ok false, hook_rejected, reason prefix, no MERGE_HEAD; second test asserts `selectMechanicalRecoveryTarget` is null at same HEAD and non-null at a changed HEAD |

Gate (re-run):
- `timeout 200 npx vitest run …gitWorktreeIntegrateSha.test.cjs …gitWorktree.test.cjs` → 1 file, 5 tests passed. `gitWorktree.test.cjs` does not exist; vitest ignored it.
- `timeout 180 npm run typecheck` → exit 0.

Reason text for other kinds: confirmed unchanged by reading the helper (identical template string).

## Findings

### Critical
- none

### Important
- `src/main/scheduler.cjs:5162`, `:3897` (`resolveHeadShasForPass`) — current base HEAD is only read when `integrationFailureKind === 'content_conflict'`; for `hook_rejected` the `currentHeadSha` passed to `selectMechanicalRecoveryTarget` is `null`. `isMechanicalRecoveryFutile` treats a null current HEAD as "not futile", so in production the retry is NOT skipped for hook rejections — the goal's "retry is skipped" holds only in the unit test, which passes the HEAD explicitly. Needs a follow-up PRD widening those three gates (`scheduler.cjs:3897`, `:5162`, and the `finalizeHeadSha` source near `:6958`) to include `hook_rejected`. This file was outside the PRD's `# Files`, so it is not a PRD-criteria failure.

### Minor
- `src/main/lib/git/gitWorktree.cjs:~1027-1035` — `mergeFailureReason` was inserted between the `AUTO_RESOLVE_EXTENSIONS` doc comment and its constant, orphaning the comment.
- The pure-addition hook path has no test (the implementer noted this).
- The PRD gate names a non-existent test file (`gitWorktree.test.cjs`).
- `/code-review` and `/security-review` were not run separately; self-review of the diff: no new input handling beyond a fixed-string match on git output, no secrets, no path handling added, no duplicated helper.

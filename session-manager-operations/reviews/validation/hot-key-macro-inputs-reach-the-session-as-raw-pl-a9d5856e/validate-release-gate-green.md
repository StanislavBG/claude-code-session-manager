# Validation: release-gate-green (plan pl-mvkklfjq-f5dee8)

Base: a2fe8ff439c3dbecb6952478c62b60eb880cc946. HEAD of main and of this job worktree is also a2fe8ff4.

## 2119-repair-stale-remote-contract-tests — REFUTED (nothing landed)

PRD file: `.../prds-archived/2119-repair-stale-remote-contract-tests.md`.

- Commits: `git log a2fe8ff4..HEAD -- tests/unit/chatRunner.spec.ts tests/unit/webRemoteDrilldown.spec.ts` is empty. `git diff a2fe8ff4..HEAD --stat` is empty. Main checkout `git log` tops out at a2fe8ff4.
- history.jsonl (line 1213) marks the row `completed` through "boot orphan reconciliation: run succeeded" (`applyOrphanOutcome`), `guardHeadBefore` = a2fe8ff4. The status came from orphan reconciliation. No commit backs it.
- Gate re-run: `npx vitest run tests/unit/chatRunner.spec.ts tests/unit/webRemoteDrilldown.spec.ts` → Test Files 2 failed, Tests 6 failed | 46 passed. These are the same 6 failures the PRD lists:
  - chatRunner.spec.ts: 'broadcasts chat:external-send…' and 'registers POST /admin/chat/send-prompt…' (extra `requestId`).
  - webRemoteDrilldown.spec.ts: transcript (paged shape), 'open tab id', 'active Epic…' (stub returns undefined), 'proposed, completed and unknown throw' (now resolves refused).
- Criteria 1-4 (updated assertions): not met. The tests still assert the old contracts. Criterion 5 ("no src/ change") holds trivially, but "both spec files pass" fails.
- Plan-level check (tests corrected, not weakened): nothing to compare, because no test edit exists.

## Findings

- Critical: the 6 failures of `npm run test:unit` remain, so the release gate is still red and the v0.121.0 release is still blocked. The 2119 job's work was lost: it was reconciled as completed after an orphaned run, with no commit.
- Minor: the history row's `completed` status is unreliable evidence for this slug. Re-queue 2119 and confirm a commit lands in the two spec files.

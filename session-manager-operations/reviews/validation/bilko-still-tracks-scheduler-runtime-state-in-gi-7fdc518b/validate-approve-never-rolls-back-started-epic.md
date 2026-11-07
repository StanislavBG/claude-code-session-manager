# Validation: approve-never-rolls-back-started-epic (PRD 2735)

Base: 83dfb526. Commit: b098fd12 (touches only the two PRD files).

## Verdict: VERIFIED

Evidence per criterion:
1. No rollback; stays active, synchronous — `src/renderer/state/promptSessions.ts` ~580-600: the `.catch` no longer sets `'proposed'`; `approveProposed` is still non-async. Test 1 asserts `approved?.status === 'active'` right after the call.
2. Retry — `retryDelaysMs=[1000,3000]`, `attemptPersist` re-reads `get().sessions`/`get().events`, same `[]`, `[id]` args, and returns silently if the Epic is missing or not `active`. Tests: 2 calls on reject-then-resolve; 3 calls on always-reject; markCompleted stops retries.
3. One toast on final failure — text `"<title>" is running but its approval was not saved: <msg>`; `grep Reopened` finds nothing in the file; the comment above the call is rewritten.
4. Second approve returns null, createWorktree once — test "a second approve after the failure returns null…" asserts both.
5. New tests present using `vi.useFakeTimers` (`promptSessions.test.ts`, describe "approveProposed persist failure keeps a started Epic active (PRD 2735)"), 4 cases.
6. Typecheck — re-ran `npm run typecheck`: exit 0.

Gate re-run: `vitest run promptSessions.test.ts launchSession.test.ts` = 2 files, 90 tests passed; `npm run typecheck` exit 0.

Diff review (self-review; 2 files, +93/-13): no unsafe input, secrets or paths. Retry timers are not cancelled on unmount, which is harmless in a store.

## Findings

### Critical
none
### Important
none
### Minor
- `src/renderer/state/promptSessions.ts` ~577: comment reads "honest-contract contract" (duplicated word left over from the edit).
- Known and out of scope per the PRD: if all retries fail, disk still says `proposed` and an app restart would reload the Epic as proposed.

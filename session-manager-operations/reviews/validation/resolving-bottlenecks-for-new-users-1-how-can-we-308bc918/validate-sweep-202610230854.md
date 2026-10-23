# Validation sweep — chat-queue-test-slot-contract (PRD 2186)

Base: 69fd7144 (as given). Note: the substantive rewrite landed earlier in 80a73bf0; within `base..HEAD` only e2718a97 touches the file (removes 3 dead SM_CHAT_CONCURRENCY lines). Verified against the HEAD tree.

## chat-queue-test-slot-contract — VERIFIED

- AC1 (cap set explicitly, FIFO): `src/main/__tests__/chat-queue.test.cjs:19` sets `SM_SESSION_SLOTS='2'`; test at :46-62 asserts `order == ['A','B']` with 3 enqueued, then `['A','B','C']` after A releases.
- AC2 (cancel while queued via exhausted pool): :64-79 — X,Y hold both slots, Z waits, `cr.cancel('Z')`, asserts order `['X','Y']`.
- AC3 (no SM_CHAT_CONCURRENCY): `grep -n SM_CHAT_CONCURRENCY` on the file → no hits (clean).
- AC4 / Gate: `timeout 300 npx vitest run src/main/__tests__/chat-queue.test.cjs` → 1 file, 3/3 tests passed.
- Env restored in afterEach (:26-27), so other tests unaffected.
- Combined diff `base..HEAD` for this PRD's file: 3 deletions only; the rest of the range is validation docs. Self-review (no product code changed beyond test env cleanup): no security concerns.

## Findings

- Critical: none
- Important: none
- Minor: none

VALIDATION: chat-queue-test-slot-contract VERIFIED

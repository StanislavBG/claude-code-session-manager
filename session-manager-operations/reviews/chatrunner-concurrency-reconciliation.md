# chatRunner concurrency test reconciliation (2026-07-24)

PRD claimed `tests/unit/chatRunner.spec.ts` was red on `main` (4 failures) because
db171bd ("fix silent-run queue leak and multi-select capture") changed
`chatRunner.cjs`'s concurrency behavior without updating the tests.

## Investigation

- `git show db171bd -- src/main/chatRunner.cjs`: the entire diff is one guard added
  inside `pump()`'s queue-position broadcast loop — `if (w.silent) return;` before
  the `chat:run:queued` emit. It does not touch admission (`pump()`'s
  `while (activeCount < CONCURRENCY_CAP ...)` loop), the per-tab exclusivity guard
  in `run()`, or the `silent` gating in `executeRun()`. It cannot affect which/how
  many runs get admitted.
- Ran `timeout 120 npx vitest run tests/unit/chatRunner.spec.ts` at HEAD (ae0e43b),
  repeated 4x: 16/16 pass every time, matching the file's current assertions
  (cap=2 queues a 3rd silent probe, manual runs bypass the cap uncapped, per-tab
  guard holds across manual/silent, recordExchange/turn-broadcasts gated on
  `silent`).
- `timeout 420 npm run test:unit`: 812 tests, 0 failed.
- `timeout 300 npm run typecheck`: clean.

## Conclusion

Neither side was wrong at this commit: `chatRunner.cjs`'s concurrency contract
(silent-lane cap enforced via `activeCount`/`CONCURRENCY_CAP`, manual runs
uncapped per PRD 493, per-tab exclusivity, recordExchange/broadcast gating on
`silent`) already matches what the test file asserts, and db171bd's queue-leak
fix was orthogonal to all of it. The failure report that prompted this PRD does
not reproduce against `main` as checked out — no `chatRunner.cjs` or test change
was needed.

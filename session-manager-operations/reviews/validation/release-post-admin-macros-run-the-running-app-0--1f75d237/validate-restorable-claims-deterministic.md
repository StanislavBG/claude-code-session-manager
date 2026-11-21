# Validation: restorable-claims-no-memoised-failed-read (PRD 3264)

Base: 614d758f. Commit: 22a0936a (only src/main/lib/epic/restorableSessions.cjs and its test).

## restorable-claims-no-memoised-failed-read — VERIFIED

- Regression test exists: `__tests__/restorableSessions.test.cjs` ~line 357, "a failed read of an unchanged archived Epic file is not memoised". It stubs `atomicFs.readJsonOrSync` with `mockReturnValueOnce(null)` and `readJsonOr` with `mockResolvedValueOnce(null)`. A real read follows, and it expects `uuid(1)` claimed. It covers sync, async, and the sync reader reading the async memo.
- Fix: `restorableSessions.cjs` `archiveRec` returns key `UNREAD_KEY` ('unread') for a null/non-object doc, so `memoHit` never matches and the next call re-reads it. Good reads keep their stat key and are still memoised. Sync and async share `archiveRec`.
- Four named tests: the diff touches only the new test and the read-call assertions in the "claimedClaudeSessionIdsAsync equals the sync set…" test. Every asserted id is unchanged; nothing was deleted, skipped, or retried (grep for skip/todo/retry: none). The `onArchives(...)` expectations in that test were widened to include `epic-bad.json`. That follows from the fix (a malformed file is re-read) and the extra reads are asserted exactly, so this is a documented behaviour change, not a loosening (Minor note below).
- Gate re-run: `npx vitest run src/main/lib/epic/` gave 28 files / 291 tests passed. `npm run test:unit` gave 1082 files / 10687 passed, 1 skipped.
- Red-on-old-code: I did not re-run the test against the old code. The commit body records it as red there, and the logic reads correctly.
- Caveat: the original transient failure was never observed. The fix stops a failed read from sticking, but that one call still returns no claim.

## Findings

- Critical: none.
- Important: none.
- Minor: `restorableSessions.cjs` `archiveRec`: malformed or empty Epic files are now re-read (one read each) on every call. The cost is bounded by the number of bad files.
- Minor: the "claimedClaudeSessionIdsAsync equals the sync set…" test now pins `epic-bad.json` among the re-reads. If malformed-file handling changes later, this assertion needs a deliberate update.
- Self-review (the /code-review and /security-review skills were not run; I read the diff): no unsafe input, secrets, or path handling added, and no helper duplicated.

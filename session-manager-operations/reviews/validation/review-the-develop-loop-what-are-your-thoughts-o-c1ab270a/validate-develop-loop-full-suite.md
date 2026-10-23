# Validation: develop-loop full suite (2183, 2184)

Base: 6348683e (given). HEAD: a4f2c8dc (re-validated by job 2187; supersedes the 69fd7144 run). 92 commits Base..HEAD (other Epics included).

## 2183 chat-queue-spec-no-private-cap — VERIFIED
- Commit 80a73bf0 changes only `src/main/__tests__/chat-queue.test.cjs` (1 file, no production code).
- Private-cap assertion (`maxActive === 2` under default cap) deleted; FIFO test rewritten as "queued runs start in FIFO order as sessionSlots frees slots" (SM_SESSION_SLOTS=2, holding executor); cancel test rewritten as "cancelling a run waiting for a session slot…". Third (silent, no `chat:run:queued`) test kept, only switched to the holding executor.
- Gate `chat-queue.test.cjs` + `chatRunner.spec.ts`: pass with SM_CHAT_CONCURRENCY unset and with `SM_CHAT_CONCURRENCY=3` (see Findings: Minor).

## 2184 queuestore-drop-scheduledfor — VERIFIED
- `grep -n scheduledFor src/main/lib/scheduler/queueStore.cjs` → no hits (rc 1).
- `grep -rn scheduledFor src --include=*.cjs` excluding `__tests__`/fixtures → no hits.
- New test `queueStoreMachineStateRecovery.test.cjs:192` loads a legacy file with `scheduledFor` and asserts the field is absent in state (:197) and on disk after write (:200).
- Commit 62fed339 touches only the two listed files. Gate specs (recovery, atomicWrite, schedulerPaths) pass; `npm run typecheck` exit 0.

## Full suite at HEAD
`timeout 900 npx vitest run`, all `SM_*` env vars unset: **790 files passed, 7509 tests passed, 1 skipped, 0 failed** (123 s).
The three previously recorded regressions are green: `tests/unit/atomic-write.spec.ts`, `src/main/__tests__/scheduler-effective-concurrency.test.cjs`, `src/main/__tests__/chat-queue.test.cjs` (also re-run individually: 7 files / 100 tests pass).

## Base comparison
No spec is red at HEAD, so there is nothing to re-run at Base; no pre-existing failures and no regressions versus Base. No PRD refuted.

## Findings
- Critical: none. Important: none.
- Minor: `queueStoreMachineStateRecovery.test.cjs:141` still has `scheduledFor: null` in a row fixture (inert test data, allowed by PRD).
- Review: `/code-review` and `/security-review` not run against a product diff (the diff is test changes plus field deletions); self-reviewed, no unsafe input, secrets or path handling.

## Re-validation at HEAD a4f2c8dc (job 2187)
- Commits touching the PRD paths since Base: 80a73bf0 + e2718a97 (2183), 62fed339 (2184), d7cf1dbd (earlier legacy-queue deletion). e2718a97 additionally removed dead `SM_CHAT_CONCURRENCY` handling from the chat-queue spec.
- Re-read: `grep scheduledFor queueStore.cjs` rc 1 (clean); non-test `.cjs` grep clean; only remaining hit in the recovery test is the inert fixture at :141 plus the new test at :192-200.
- Gates re-run with all `SM_*` unset: chat-queue + chatRunner 2 files/44 tests pass; queueStore recovery/atomicWrite/schedulerPaths 3 files/42 tests pass; `npm run typecheck` exit 0.
- Full `timeout 900 npx vitest run` (SM_* unset): 790 files passed, 7509 passed, 1 skipped, 0 failed (123 s). atomic-write.spec.ts, scheduler-effective-concurrency.test.cjs, chat-queue.test.cjs all green.
- Nothing red, so no Base re-run needed; no regressions, no pre-existing failures. Both PRDs VERIFIED.

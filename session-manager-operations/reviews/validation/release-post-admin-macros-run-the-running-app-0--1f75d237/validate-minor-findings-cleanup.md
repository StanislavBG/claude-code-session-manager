# Validation: minor-findings cleanup wave

Base: f5ef0830a946bdf761390ab5cbb46b5f45519526 (known). Commits: ce50c9fa (3353), cc753785 (3354), b6029257 (3355). Review done by reading the diff myself (self-review for correctness, secrets, path traversal, duplication).

## claim-scan-malformed-memo-and-fail-closed — VERIFIED
- Malformed file memoised: `archiveRec` returns `{ key, sid: null }` for `{doc:null}` (restorableSessions.cjs, archiveRec); test asserts `archiveReads(...)` is `[]` on the second call, sync and async.
- I/O retry: `readArchiveSync(file)` is retried once at the call sites; test asserts `['epic-a.json','epic-a.json']` reads and that uuid(1) is claimed in the same call.
- Retry fails: `archiveRec` returns UNREAD_KEY (not memoised) and `onUnreadable` sets `incomplete`; the entry carries `incomplete`.
- Consumers fail closed: `listRestorableSessions` returns `result` with no rows when `claimScanIncomplete`; `checkRestorableSessionSync` refuses with `claim_check_unreadable` (retryable text). One test per consumer present; the list test shows rows return after a successful re-scan.
- No test skipped or loosened: the only expectation change is epic-bad.json no longer re-read (the sanctioned one) and the read spy retargeted to fs; no skip/only lines were added. The 1 skip in the full run is pre-existing, not in this diff.
- Gate: `npx vitest run src/main/lib/epic/` → 35 files, 372 tests pass. `npm run test:unit` → 1106 files, 11140 passed, 1 skipped, 0 failed (HEAD includes 70524803, which fixed the two earlier failures).

## builder-persona-token-path-consistent — VERIFIED
- 'a bridge, not durable' is gone; step 3 now says the bypass-2FA granular token is the current publish path (owner decision 2026-11-21), keeps the github.blog changelog link and January 2027.
- States direct publishing ends → staged publish the owner approves with 2FA on npmjs.com, unless Trusted Publishing is restored from 9f7b2627; staged (E409) is reported as waiting for owner approval.
- Diff touches only step 3; build-target.md unchanged (no contradiction found).
- Diff scan for token, email and personal name: none found.
- Gate: node check prints "builder ok"; `npm run lint:docs` ok.

## prd-authoring-traceable-criteria — VERIFIED
- One line added after the §3 item in §14 starting `**Traceable criteria:**`, with the tree/commit/read-only-probe rule, run-report rule, and Why citing the 2026-11-21 release fix plan (3240). `git diff` shows exactly +1 line.
- Gate: marker check passes; the 4 named tests pass (22 tests); `lint:docs` ok.

## Findings
- Critical: none.
- Important: none.
- Minor (new, unowned — needs a cleanup PRD or explicit close reason):
  1. restorableSessions.cjs (`listRestorableSessions` / `claimScanIncomplete`): `incomplete` is read from the shared per-cwd memo after the await, so a concurrent scan of the same cwd could overwrite the entry between the scan and the check, and the consumer could see another scan's flag. It errs only toward a spurious refusal or empty list in a narrow race, but the flag is not returned by the scan that produced it.
  2. restorableSessions.cjs `readArchiveSync/Async`: ENOENT is treated as "owns nothing" (not io). Justified in the comment by tmp+rename writes, but there is no test pinning that choice.
- Minor (pre-existing, from base notes): none added.

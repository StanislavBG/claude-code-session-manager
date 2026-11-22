# Validation: video-review-ipc-tests-and-in-flight-message

Base: e3f4e144. Commit: 7dbc8674 (touches only the two PRD files).

## video-review-ipc-tests-and-in-flight-message — VERIFIED
- AC1: stub `checkProjectVideoToolRunnable: vi.fn(async () => ({ ok: true }))` in shared `setup()` deps (videoReviewIpc.test.cjs:59); existing assertions unchanged apart from the two in-flight ones.
- AC2: new test "a tool whose persona cannot run it…" (diff +285): approve and retry both `toEqual({ok:false,error})`; createPrd/archivePrd not called; decision.json absent / unchanged; status 'waiting' after approve, 'approved' + canRetry true after retry.
- AC3: videoReviewIpc.cjs:32 IN_FLIGHT_ERROR has the new text; returned by decide (:117) and retry (:167) on the shared `inFlight` set; comment at :35 says decides and retries.
- AC4: both in-flight assertions use the new exact text; `grep -rn 'already being sent' src` finds nothing.
- Gate (`none` in this validate PRD; the PRD's own gate re-run): vitest on videoReviewIpc, videoReview, macroJobIpc → 3 files, 61/61 passed.

## Review
Diff is 2 files, 26 insertions, 4 deletions. Self-review: no unsafe input handling, secrets or path handling added; no duplicated helper. /code-review and /security-review not run separately (tiny test/message diff).

## Findings
- Critical: none
- Important: none
- Minor: none

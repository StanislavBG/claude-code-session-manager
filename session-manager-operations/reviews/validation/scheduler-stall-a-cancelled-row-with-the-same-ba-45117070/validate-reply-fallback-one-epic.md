# Validation: reply fallback reuses one Epic per thread

Base: a2b9803603f5b92e5d5b3bb8517d0dfc9e2f259c. Commits: aa5e020a (3501), b962781d (3502).
Gate re-run: `timeout 300 npx vitest run .../replyFallbackReuse.test.cjs .../crossProjectReply.test.cjs` → 2 files, 41 tests passed.
/code-review and /security-review were not run as separate skills; the diff was self-reviewed (no secrets, no new path handling beyond existing `path.resolve` compares, no new mint authority).

## reply-fallback-reuses-open-thread-epic — VERIFIED
- Lookup: `findOpenReplyFallback` crossProjectFeedback.cjs:961 reads the toCwd active index, matches producer `cross-project-feedback`, replyOf {cwd,epicId}, fromCwd, fromEpicId, status proposed/active.
- Reuse returns `{ok:true, epicId, reused:true, status}` before any mint (:1024+); audit `epic_cross_project_reply_fallback_reused` with the required fields; completed/removed rows never match.
- Different fromEpicId not reused: test `replyFallbackReuse.test.cjs:149`; completed not reused :121; archived :137; reuse + single ensureEpic call :90.
- MINT_AUTHORITIES untouched (diff only in crossProjectFeedback.cjs + tests).

## reply-dedupes-retries-and-lands-in-reused-epic — VERIFIED
- `reply.hash` = sha256(outcome\nmessage) on delivered, event-only and fallback receipts (crossProjectReply.cjs:~184, receipts in fallback/delivered/replyAsEvent).
- Identical retry vs latest receipt returns `alreadyDelivered:true` with earlier fields before the cap check (:280), no receipt, cap unused.
- Reused fallback: `deliverIntoReusedFallback` (:510) — active gets event + sendPrompt, proposed gets event with allowInactive; returns delivery 'fallback', fallbackEpicId, reused:true.
- Tests (crossProjectReply.test.cjs): deliver-twice :624; identical retry + hashes :649; blocked-then-done :665; reused ACTIVE :690. All green.

## Prevented by construction
The 2026-11-21 duplicate (Self Epics -bcfb66ae and -937b88ba from two replies on one thread) cannot recur:
1. A later reply reuses the open fallback Epic — `findOpenReplyFallback` runs before mint. Proof: `replyFallbackReuse.test.cjs:90` (ensureEpic called once) and `crossProjectReply.test.cjs:665` (blocked then done: one Epic, both messages in it, two receipts).
2. An identical retry returns the earlier result — hash compare against the latest receipt. Proof: `crossProjectReply.test.cjs:624` (delivered twice: one Epic, one receipt, cap not consumed) and `:649`.

## Findings
Critical: none. Important: none.
Minor:
- src/main/promptSessionEvents.cjs (~:118-126) changed though absent from 3502's # Files; necessary so the new receipt keys persist, disclosed in the commit message.
- crossProjectReply.cjs:280 dedupes only against the LATEST receipt; an A,B,A sequence re-delivers A (by spec, counts toward the cap).
- Reuse matches on the thread's replier pair, not the thread id alone; matches the PRD wording.

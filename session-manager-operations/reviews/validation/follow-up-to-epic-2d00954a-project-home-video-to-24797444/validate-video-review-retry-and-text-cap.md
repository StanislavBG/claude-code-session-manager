# Validation: video review Retry + 32000-char review text

Base: f6b87755b68bea3ec05596360fca8a66035a91fa (from the PRD's implementation notes; commits on HEAD since then were listed with `git log`).
Gates re-run in the foreground, all exit 0: 7 test files / 403 tests (macroJobStatus, videoReviewIpc, videoReview, apiSurface, VideoReviewPanel, scheduler-notify-originating-tab, mcpToolCatalog); `npm run typecheck`; `lint:selectors` OK; `lint:hooks` OK; `lint:docs` OK; `lint:readme` OK.
`/code-review` and `/security-review` were not run as skills; self-reviewed the diff for correctness, input handling, path traversal and helper duplication.

## job-status-by-slug — VERIFIED
- `jobStatusesBySlug` at src/main/lib/persona-macro/macroJobStatus.cjs:160-188 reuses toStatus/newest/parseHistory. Values are `{slug,state,status,reason,startedAt,finishedAt}` or null.
- Live row with `r.cwd === cwd` wins (:167,:181). History is loaded lazily, once, and only when a slug has no live row (:170-182).
- Empty slugs return `{}` before loadJobs (:162). Throws are caught (:168,:175) and give null values.
- macroJobStatuses is untouched, still exported (:190). The new tests pass.

## video-review-retry-ipc — VERIFIED
- review-list adds `job` and `canRetry` (videoReviewIpc.cjs:195-206). `retryable` (:51-57) requires approved + approve with non-empty at + final stage + job failed.
- review-retry (:163-192) re-checks at call time, calls runToolJob with the recorded macroId/epicId/inputValues, `replaceEntryInstructions` and `review {approved, at: rev.decision.at}`, and writes no decision.
- The not-retryable error text is exact (:31). An inactive Epic is refused by runToolJob. The in-flight set is shared with decide (:167).
- The old slug is archived best effort (:185-187). No job row counts as not failed (:56).
- Strict `projectVideosReviewRetry` schema at src/main/ipcSchemas.cjs:1083, registered at :1832.
- Tests: videoReviewIpc.test.cjs covers canRetry cases, the stored at, archive, concurrent retries (:270), and the refusals.

## preload-video-review-retry — VERIFIED
- `reviewRetry` at src/preload/index.cjs:453, in the same namespace as reviewDecide. Typed at api.d.ts:3093. Listed in apiSurface.json:1811. Surface test and typecheck are green.
- Not individually re-read: the `remote: 'deny'` value in apiSurface.json (apiSurface.test passes) and the job/canRetry fields on VideoReview in api.d.ts (typecheck passes).

## video-review-retry-card — VERIFIED
- VideoReviewPanel.tsx: 'Final run failed' card (:77-81), 'Retry final run' button disabled while busy (:96), `window.api.projectPages.reviewRetry` called once per click (:260), toasts and reload. The panel test passes, as do lint:selectors and lint:hooks.

## final-run-failed-notice — VERIFIED
- scheduler.cjs macroBuildNotice returns the exact 'FAILED — <label>: the approved final run for entry <id> failed (<reason>). Press Retry on it in Project Home ▸ Video; your approval is kept.' message. A try/catch falls back to the generic message on a listReviews throw. The test file is green.

## docs-video-review-retry-and-text-cap — VERIFIED
- project-pages/README.md:214-231 holds the limits (32000, 1-6), the stored at, Retry (human click only) and the final-dispatch rule. domain-model.md:160 has one sentence linking to the README. lint:docs is OK.

## mcp-recipe-video-review-retry — VERIFIED
- mcpToolCatalog.cjs:808-809 names 32000 and 1-6 images, and describes Retry with the same Review/Replace lines and no agent retry. The test asserts '32000' and 'Retry' (mcpToolCatalog.test.cjs:184). lint:readme passes.

## 3564-video-review-store (amended criteria) — VERIFIED
- `REVIEW_TEXT_MAX = 32000` at videoReview.cjs:27, enforced at :134. The admin-route test saves 32000 chars and refuses 32001 (projectHomeAdminRoutes.test.cjs:645-654).
- writeDecision stores `record.at` for an approval (:189-192).
- reviewStatus excludes a final dispatch once a decision exists (:85). Tests at videoReview.test.cjs:175 and :210.

## 3565-video-review-write-route-and-mcp (amended criteria) — VERIFIED
- The route test saves 32000 chars and refuses 32001. The MCP input schema has `maxLength: REVIEW_TEXT_MAX` and mentions 32000 (scheduler-mcp-server.cjs:897; catalog test :404-405).
- Ran node over the 36 MCP_TOOL_CATALOG entries: none has 'approve', 'decide' or 'retry' in its name. The admin routes file has no such route; its decision keys are refused (test :657).

## 3568-video-review-decide-ipc (amended criteria) — VERIFIED
- decide computes `at` once and passes it to both runToolJob and writeDecision (videoReviewIpc.cjs:133-152); the test checks the stored at matches the run's (:121-122). The in-flight set makes concurrent decides dispatch once (test :168).

## Findings
### Critical
- none
### Important
- none
### Minor
- src/main/lib/project-pages/videoReviewIpc.cjs:32 — IN_FLIGHT_ERROR reads "a decision for this entry is already being sent", which is also what a refused concurrent Retry shows. Wording only.
- Worktree status shows project-pages/demo-video/index.html and home.html as deleted. They are the foreign WIP paths named in the prompt and are not part of this plan. They are not staged here.

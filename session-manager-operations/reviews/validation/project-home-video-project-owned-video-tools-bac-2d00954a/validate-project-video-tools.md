# Validation: project-video-tools

Base: acb01fb580a0bb83fe97351c34c7046e3f5848c1 (known). All 20 implementation PRDs have commits in base..HEAD over their paths.

## scene-markers-accept-number-scenes
Verdict: VERIFIED
Evidence: playerBridge.cjs number scene start accepted (+4 lines); playerBridge.test.cjs green

## demo-video-kit-version-3
Verdict: VERIFIED
Evidence: seedKit.cjs KIT_VERSION 3 + pinned KIT_DIGEST; seedKit.test.cjs green

## mcp-htmlpath-length-scaled-cap
Verdict: VERIFIED
Evidence: mcp server htmlPath cap scales by lengthS; scheduler-mcp-server-htmlPath + projectHomeAdminRoutes tests green

## video-aspect-meta-and-episode-kind
Verdict: VERIFIED
Evidence: meta.aspect from sm-demo-aspect + kind 'episode' in projectHomeAdminRoutes/pagesLibrary; tests green

## video-player-upright-9x16
Verdict: VERIFIED
Evidence: VideoPlayer.tsx upright frame + Episode label; VideoPlayer/VideosPane tests, typecheck, lint:selectors, lint:hooks clean

## macro-library-project-video-surface
Verdict: VERIFIED
Evidence: macroLibrary.cjs surface 'project-video', one-project scope, job stored; macroLibrary/builtinMacros tests green

## macro-save-routes-accept-project-video
Verdict: VERIFIED
Evidence: macroAdminRoutes.cjs accepts project-video with job, scoped to caller; tests green

## video-review-store
Verdict: VERIFIED
Evidence: videoReview.cjs dispatch/material/decision records + reviewStatus; videoReview.test green

## video-review-write-route-and-mcp
Verdict: VERIFIED
Evidence: projectHomeAdminRoutes.cjs:370 only /videos/review/write (material); decision-shaped keys refused (:451); no admin route/MCP tool writes decision (grep: mcpToolCatalog only has project_video_review_write); tests + lint:readme green

## macro-job-dispatch-project-tools
Verdict: VERIFIED
Evidence: macroJobDispatch.cjs resolveProjectTool (library, project-video, one project, job); builtins path unchanged (diff read; macroJobDispatch tests green); Review: lines stripped from caller input

## macro-job-ipc-project-tools
Verdict: VERIFIED
Evidence: macroJobIpc/macroJobStatus wired for tools; tests green

## video-review-decide-ipc
Verdict: VERIFIED
Evidence: videoReviewIpc.cjs: renderer IPC only, header 'nothing here mints an Epic', inactive Epic refused, in-flight guard; tests green

## preload-video-review-bridge
Verdict: VERIFIED
Evidence: preload/index.cjs + apiSurface.json + api.d.ts expose reviewList/reviewDecide; apiSurface test + typecheck green

## macro-launch-forwards-input-values
Verdict: VERIFIED
Evidence: useMacroLaunch.ts/launchSession.ts forward inputValues; tests green

## videos-pane-lists-project-tools
Verdict: VERIFIED
Evidence: VideosPane.tsx lists project tools; VideosPane/ProjectPagesSection tests green

## video-review-panel
Verdict: VERIFIED
Evidence: VideoReviewPanel.tsx added; its test + VideosPane green

## hot-keys-and-tools-skip-project-video
Verdict: VERIFIED
Evidence: SessionActionsBar/ToolsPane skip project-video, MacroEditor surface move; tests green

## mcp-docs-project-video-tools
Verdict: VERIFIED
Evidence: mcpToolCatalog.cjs:501,587-808 documents tools/review/episode/cap; catalog test + lint:readme green

## docs-project-video-tools-law
Verdict: VERIFIED
Evidence: domain-model.md/project-pages README updated; CLAUDE.md 11041 bytes <= 12000

## macro-build-notice-review-stage
Verdict: VERIFIED
Evidence: scheduler.cjs review-stage WAITING notice; scheduler-notify-originating-tab test green

## remote-skips-project-video-tools
Verdict: VERIFIED
Evidence: webRemote.cjs skips project-video; web-remote-project-video + retire-d2d tests green

## Combined checks
- vitest (30 main/preload files, 852 tests) green; renderer projecthome + epics + lib (52 files, 965 tests, incl. project-pages, persona-macro) green.
- npm run typecheck clean; lint:selectors OK; lint:hooks OK; lint:readme OK.
- /code-review and /security-review not run as separate commands; self-reviewed: decision writes are IPC-only, review text/images size-bounded and videoId regex-validated, no path traversal found, no secrets.

## Findings
Critical: none.
Important: none.
Minor: foreign uncommitted files (demo-video/index.html, home.html) untouched; PRD files were all present.

VALIDATION lines:
VALIDATION: scene-markers-accept-number-scenes VERIFIED
VALIDATION: demo-video-kit-version-3 VERIFIED
VALIDATION: mcp-htmlpath-length-scaled-cap VERIFIED
VALIDATION: video-aspect-meta-and-episode-kind VERIFIED
VALIDATION: video-player-upright-9x16 VERIFIED
VALIDATION: macro-library-project-video-surface VERIFIED
VALIDATION: macro-save-routes-accept-project-video VERIFIED
VALIDATION: video-review-store VERIFIED
VALIDATION: video-review-write-route-and-mcp VERIFIED
VALIDATION: macro-job-dispatch-project-tools VERIFIED
VALIDATION: macro-job-ipc-project-tools VERIFIED
VALIDATION: video-review-decide-ipc VERIFIED
VALIDATION: preload-video-review-bridge VERIFIED
VALIDATION: macro-launch-forwards-input-values VERIFIED
VALIDATION: videos-pane-lists-project-tools VERIFIED
VALIDATION: video-review-panel VERIFIED
VALIDATION: hot-keys-and-tools-skip-project-video VERIFIED
VALIDATION: mcp-docs-project-video-tools VERIFIED
VALIDATION: docs-project-video-tools-law VERIFIED
VALIDATION: macro-build-notice-review-stage VERIFIED
VALIDATION: remote-skips-project-video-tools VERIFIED

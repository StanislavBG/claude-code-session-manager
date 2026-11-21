# Validation: feedback-mcp-text-goal-description-images

Base: cd48c8ff4e52c4d67c32c241a3e6301293cfe336 (7 commits, 22 files, +1040/-109).

Gate re-run (foreground): vitest on all 10 test files of the 6 code PRDs — 10 files / 243 tests passed; `npm run typecheck` (renderer + main) clean; `lint:selectors` OK; `lint:hooks` OK.

## feedback-images-prepare — VERIFIED
- feedbackImages.cjs:1 `// @ts-check`; constants 19-22 match; tsconfig.main.json include entry added.
- Empty/undefined -> ok []; >5 -> error naming limit (:84-89).
- Path: absolute, isFile, size cap, `sniffImageMime` reused from epicAttachments (:17,124); errors carry index + basename only.
- Data URL: regex + base64 check + sniff must equal declared mime (:129-140).
- Downscale via injectable nativeImage, edges 2000/1600/1280/1024 x q85/70 (:26-27,58-76); WebP/GIF oversize refused (:146); total cap (:157).
- Tests present in feedbackImages.test.cjs (green).

## feedback-client-images — VERIFIED
- validateImages (max 5, regex, 2,000,000 chars) rejects before fetch; images key only when non-empty; imageWarning texts exact; item.imageCount = images.length ? acked : 0; MAX_IMAGES exported; api.d.ts submit/imageCount/warning updated. Image data not persisted (only imageCount).

## feedback-submit-routes-images — VERIFIED
- ipcSchemas: images (max 5, dataUrl max 35M), imagePaths (max 5, 4096). submitFeedback maps both into one prepare call; prepare error short-circuits client.submit; result returned unchanged. Admin route: non-absolute -> 400 'imagePaths must be absolute paths' before submit; warning passed through; redactHome unchanged; no image bytes logged/echoed.

## feedback-mcp-goal-description-images — VERIFIED
- Schema goal/description/tag/imagePaths(maxItems 5), required exactly goal/description/tag (scheduler-mcp-server.cjs); handler keeps headless refusal first, validates imagePaths, maps goal->title, description->body, imagePaths only when non-empty; header comment updated; catalog tests green.
- No `{F}` remains in mcpToolCatalog.cjs or the server.

## feedback-panel-goal-description-images — VERIFIED
- Labels Goal (n/120) and Description; testids unchanged; add-images button, hidden multi input, thumbnails/remove testids; limits 5 / 25 MB / type enforced with error toasts (Panel :39-40,137-140); SESSION_PHRASE updated; store submit returns Promise<boolean>, passes images only when non-empty, warns via toast.warn; lint:selectors/hooks green. Object-URL lifecycle delegated to the existing useAttachments hook (not modified).

## feedback-button-label-tooltip — VERIFIED
- TabBar.tsx: button text 'Feedback', aria-label/expanded/onClick/unseen-dot kept, wrapped in Tooltip with exported FEEDBACK_TOOLTIP (exact text) and same `title`; header comment updated; tests green.

## feedback-images-doc — VERIFIED
- customer-feedback.md: Submit row documents images/limits/imageCount+warning; field table lists imageCount; 'Ever transmitted?' says bytes never stored locally; lifecycle and admin route name new signatures; module map lists feedbackImages.cjs; sniffing/downscale/not-redacted noted; owner pull `images=none` line added. Statements match the code read above.

## Combined diff review (image upload safety)
- Only sniffed images leave the machine: every image (path or data URL) passes through prepareFeedbackImages (magic-byte sniff, mime match); client re-checks data-URL shape. Arbitrary file upload via the MCP path is not possible; non-regular files and >25 MB are refused.
- No image bytes logged or stored: no console/log calls in feedbackImages.cjs; the admin route echoes only item/warning; the store persists only imageCount.
- Path traversal: absolute-path required, regular-file check, content sniff (a symlink to an image elsewhere is allowed — acceptable, the human directed the agent).
- Caps hold: per-image 1.9M chars, total 8M, count 5 at schema, prepare and client.

## Findings
### Critical
- none
### Important
- none
### Minor
- src/main/lib/feedback-remote/customerFeedbackAdminRoutes.cjs:11 and src/renderer/state/customerFeedback.ts:4 comments still say "{F}" (outside the PRDs' file scopes).
- Panel object-URL revocation relies on useAttachments (not re-verified line by line in this run); unit tests pass.

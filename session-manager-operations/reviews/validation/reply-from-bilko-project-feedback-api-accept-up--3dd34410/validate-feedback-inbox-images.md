# Validation: feedback-inbox-images plan

Base: dbbca0cb75483c6195967160d180cc6c4d08487a. Commits: bef01ef4 (cache), 6b243ba8 (ipc), 142264b9 (ui), 2ca83bd4 (doc).
Gates re-run in the foreground: vitest on customerFeedbackInbox, customerFeedbackIpc, CustomerFeedbackInbox.test.tsx, state/customerFeedback, preload-surface → 5 files / 48 tests passed; `npm run typecheck` exit 0; `lint:selectors` OK; `lint:hooks` OK.
Self-review used (no medium-level reviewer run): no path traversal (SAFE_ID_RE + `startsWith(root)` in readCachedImage), no bytes/token logged, no dataUrl into prompts.

## feedback-inbox-image-cache — VERIFIED
- toItem → `toImages` (customerFeedbackInbox.cjs:165-181): ordered, slice(0,5), keeps prev path; `images` type at api.d.ts:728.
- Page loop still `images=none` (:325); targeted GET `since`=receivedAt−1 s, `limit=20`, bearer, `AbortSignal.timeout`, find by id, cap `MAX_IMAGE_FETCHES` 20 (:239-262).
- decodeImage (:203-215) validates regex, ≤2,000,000, base64, sniff==mime; written `<imagesDir>/<id>/<n><ext>` mode 0o600 via writeTextAtomic (:271-273); SAFE_ID_RE gate (:240); pruneImages (:294-303).
- Failures leave null and are swallowed (:278, :355); returns `{ok,fetched,pages,imagesCached}` (:358).
- readCachedImage (:366-385) + export (:462); owner check, id, index 0-4, in-dir, re-sniff; api.d.ts:2551 declares inboxImage.
- Tests present and green (customerFeedbackInbox.test.cjs).

## feedback-inbox-image-ipc — VERIFIED
- customerFeedbackIpc.cjs:60 handler; ipcSchemas.cjs:1466 schema + :1714 export; preload/index.cjs:279 bridge; preload-surface and Ipc tests green.

## feedback-inbox-images-ui — VERIFIED
- InboxImages (CustomerFeedbackInbox.tsx diff): thumbnails by non-null path, alt `Customer image N`, `N image(s) not downloaded yet. Pull to retry.`, per-thumb `Could not load image`, returns null when empty; hooks above the early return; selectors/hooks lint clean.
- buildIntake appends label + `Attached: <path>` lines only when cached; otherwise goal unchanged.
- Component tests added (+84 lines) and pass.

## feedback-inbox-images-doc — VERIFIED
- customer-feedback.md diff: images=none replaced by owner-images paragraph (since/limit/20/validation/path 0600/prune); "Owner image fetch" table row; `images` field row with bytes = data-URL chars; privacy bullets (cache, re-validation, inbox-image only, Attached: lines + label); IPC list has `inbox-image`; module map row mentions cache + readCachedImage.

## Findings
### Critical
- none
### Important
- none
### Minor
- customerFeedbackInbox.cjs:249-262: one GET per item (as specified) re-downloads up to 20 items' images each time; cost is bounded by the 20-item cap, fine.
- Range diff also contains unrelated commits (claude-config, editor, `source.externalRef` 6251931c in promptSessionSchema.cjs); not part of these PRDs, not reviewed here.
- Foreign uncommitted files (project-pages/*) were untouched.

# Validation: chat URLs clickable into the OS browser

Base: ada0c082f1608e65d3cf2a354334cb1587f664c0 (known). PRD files: 1537/1538/1542 in `prds-archived/`, 1540 in `prds/`.
Gates re-run (node_modules symlinked from the main checkout; worktree has none):
- `npx vitest run` on UrlCallout, ChatTranscriptTurn, extractUrls, chatFileLinks, handleChatLinkClick, chatCodeUrlLinks → 6 files, 73 tests passed.
- `npm run typecheck` → exit 0. `npm run lint` → exit 0.

## chat-url-callout-click-opens-browser — VERIFIED
Commit abbbd62d.
- `export function UrlCallout`: ChatTranscriptTurn.tsx:48.
- `<button type="button">` with title "Open in browser", testid `chat-url-callout-open`, truncate/font-mono/hover:underline/cursor-pointer: ChatTranscriptTurn.tsx:73-80.
- `shell.open({ as:'external', url })` once; Copy is a separate button that calls only `onCopy`: :60-67, :83.
- `/^https?:\/\//i` guard before the call: :61.
- Rejection and `{ok:false}` → `toast.error('Could not open link: …')`: :62-66.
- Tests in UrlCallout.test.tsx (new, passing).

## extract-urls-trim-trailing-markdown — VERIFIED
Commit 34ef155b.
- Trim set `* _ ~ \` . , ; : ! ? ' " ]`, unbalanced-`)` rule: extractUrls.ts:6-26.
- Bare branch only (`m[1] ?? trim(m[0])`), backtick excluded from the class, dedup on trimmed value, bare `https://` skipped, cap and `[label](url)` branch intact: extractUrls.ts:27-42.
- extractUrls.test.ts +56 lines, passing.

## chat-file-links-skip-bare-domains — VERIFIED
Commit 631651e7.
- `DOMAIN_TLDS` Set holds all 18 required TLDs: chatFileLinks.ts:35-38.
- Check runs after the `/` early-return, so tokens with a separator are unaffected: chatFileLinks.ts:41-47.
- Both `linkifyFilePaths` and `extractFilePaths` go through `isPlausibleFilePath`.
- Tests added in chatFileLinks.test.ts (+24), passing; the gate also passes handleChatLinkClick.test.ts.

## chat-inline-code-urls-clickable — VERIFIED
Commit 5dca01ee.
- chatCodeUrlLinks.ts exports `linkifyCodeUrls`. It skips `closest('pre, a')`, matches only `^https?://…$`, sets href via `setAttribute`, and is idempotent because wrapped code sits inside an `<a>`.
- `linkifyCodeUrls(bodyRef.current)` is called right after `linkifyFilePaths`: ChatTranscriptTurn.tsx:1145-1146.
- chatCodeUrlLinks.test.ts covers wrap, pre, mixed text, javascript:, idempotence, and the handleChatLinkClick → shell.open click path (passing).

## End-to-end note
`**https://stanislavbg.github.io/git-viewer/**` → trimmed to `https://stanislavbg.github.io/git-viewer/` (extractUrls) → callout button → `shell.open({as:'external',url})`. `bilko.run` → no file chip (DOMAIN_TLDS). Inline-code URL → `<a>` → existing handleChatLinkClick branch. All three are covered by the passing tests.

## Combined diff review
The diff also carries unrelated scheduler commits (8ff5e16e sentinel_fail in runVerify.cjs, 4f401df6 + 79412477 in gitWorktree.cjs/scheduler.cjs, plus sched-primitives.tsx and rcaReport.cjs). They are outside this plan and were not validated here. Self-review of the plan's renderer changes (`/code-review` and `/security-review` self-applied): no secrets, no path handling, no innerHTML. URL schemes are restricted to http(s) in the renderer, and main also enforces it.

### Findings
- Critical: none.
- Important: none.
- Minor: `linkifyCodeUrls` accepts any `https?://` text up to whitespace or `<>"'`. This is safe because main re-validates the scheme, but it is not host-validated (acceptable).
- Minor: extractUrls.ts:34 — the bare-URL class now includes `)`. A parenthesised URL such as `(https://a.io/x)` is handled by the unbalanced-`)` rule, but `(see https://a.io/x),` relies on the iterative trim; it is covered.
- Minor: PRD 1540 is still in `prds/` rather than `prds-archived/`. This is bookkeeping only.

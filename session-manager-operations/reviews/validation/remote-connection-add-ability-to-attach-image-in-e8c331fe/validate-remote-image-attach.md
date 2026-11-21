# Validation: remote image attach plan

Base: 27aa9a5fdb45413f36bcc9c5f14eedd2f7fb5c3d, HEAD 305388eb. All 15 PRD files found in prds-archived/ (3253 exists twice: remote-renderer-save-binary-proof and fix-remote-renderer-save-binary-proof).
Commands run (foreground):
- Root vitest over every desktop gate file: 15 files / 174 tests pass.
- `npm run typecheck` (root): exit 0.
- `web/remote-app` full `npm test`: 44 files, 333 passed, 1 skipped, 0 failed. It covers every remote-app gate, including both browser chain specs. The job worktree has no `web/remote-app/node_modules` (all 44 files failed to import `@testing-library/jest-dom`), so this was run in the main checkout, which is at the same HEAD 305388eb.
- `web/remote-app` typecheck: 2 errors, see Findings.
- `/code-review` and `/security-review` were not run; I did a self-review of the webRemote, ws.ts, epicAttachments and MicPane diffs instead.
- Lint, which the fix-3253 gate lists, was not re-run.

## Per-PRD
- remote-frame-assembler: VERIFIED. remoteFrameAssembler.cjs plus its test pass; the lib-layout entry is present; the diff stat shows the file at 113 lines.
- epic-chat-image-store: VERIFIED. epicAttachments.cjs:66-104 validates every image before writing (base64, mime, magic bytes, caps) and removes partial writes on failure. removeSavedAttachments (:118-129) only unlinks inside the attachments dir.
- remote-app-frame-chunker: VERIFIED. frames.spec.ts passes, including the interop test against the desktop joinFrames.
- remote-app-image-prep: VERIFIED. image-attach.spec.ts passes.
- remote-app-device-capabilities: VERIFIED. The store and remote-ready specs pass.
- web-remote-frames-wire: VERIFIED. webRemote.cjs handleFrame returns early unless `client.e2e.state === 'authenticated'` and remoteEnabled, so frames are buffered only for authenticated, enabled clients. The kill switch drops partials. Frames are dropped on failClient and teardown.
- remote-app-framed-send: VERIFIED. ws-frames.spec.ts and the related specs pass.
- remote-app-framed-send-pacing: VERIFIED. `sendRaw` (ws.ts) is the single choke point and refuses anything over 252 KiB (MAX_WIRE_BYTES). Pacing uses bufferedAmount and SendBudget; a relay error or the deadline aborts the send. ws-frames-pacing.spec.ts passes.
- web-remote-chat-send-images: VERIFIED. The target is resolved before any write (webRemote.cjs `cmd:chat:send`, "Resolve the target BEFORE writing anything"). Refused targets return before saveChatImages. Files are removed on a definite refusal or a throw. The web-remote-chat-send tests pass.
- remote-app-composer-attach: VERIFIED. MicPane.tsx:75 reads the `chat-images` capability. The attach (:133, :155) and send (:185) paths refuse without it. mic-pane and session-screen specs pass.
- remote-app-transcript-attachments: VERIFIED. attached-lines.spec.ts and the session-screen specs pass.
- remote-transcript-keep-attached-lines: VERIFIED. The remoteTranscriptTail tests pass.
- phone-image-send-chain-proof: VERIFIED. The browser chain spec passes.
- remote-renderer-save-binary-proof (and fix-remote-renderer-save-binary-proof): VERIFIED. The browser spec passes (2 tests); apiSurface and remoteApi vitest pass; root typecheck is green.

## Findings
Critical: none.

Important:
- `web/remote-app` `npm run typecheck` is red, 2 errors, both in `src/__tests__/remote-renderer-save-binary.browser.spec.ts`: :231 `maxPayload` is not in `ServerOptions`, and :260 `'close'` is not assignable to the `'message'` overload. Vitest passes, so only tsc fails. It breaks the "run once" typecheck command and the earlier PRDs' typecheck gates. Fix the test's ws typings.

Minor:
- The worktree has no `web/remote-app/node_modules`, so remote-app gates cannot run in an isolated job worktree. This is an environment issue.
- 3253 has two PRD files with the same number. The fix variant's gate repeats the browser spec line twice.
- `data` max is 4.2 MB per image in ipcSchemas (`remoteChatImage`). saveChatImages enforces the real 3 MB cap, so this is safe.

# Validation: web-remote laptop sessions and UI

Base: e4163106431161b33e7e01c3e44f0a6703e448f8. PRD files found in `prds-archived/` (2417–2420). Commits: 65200b69 (2417), a37fbfb2 (2418), 44b8c623 (2419), d059dc30 (2420).
Self-review only (no separate /code-review run); the combined diff for these four PRDs was read in full.

## remote-renderer-falls-back-when-ui-missing — VERIFIED
- Missing local css/script -> `setState({kind:'fallback'})`, absolute refs skipped: RemoteRenderer.tsx loader (`isLocalRef`, ~L82, L279-293).
- No local script -> fallback: `if (boot.length === 0)` ~L296.
- `export const BOOT_WATCHDOG_MS = 15000` L85; timer starts in the ready useLayoutEffect, cleared on `sm-ipc`/`sm-ipc-subscribe` and in cleanup (~L313-327).
- Tests (a) manifest-only index.html, no asset:get beyond index.html; (b) watchdog fallback; (c) sm-ipc keeps iframe — all in remoteRenderer.spec.tsx.
- Gate: `npm --prefix web/remote-app ci && typecheck && test` -> exit 0; 32 files, 203 passed, 1 skipped (the SM_REAL_DIST_WEB case).

## dist-web-flat-and-release-check — VERIFIED
- vite.web.config.ts: entryFileNames `app.js`, css `app.css`, other `[name]-[hash][extname]`.
- `missingEntryFiles()` exported from remoteAssets.cjs; resolveAsset untouched; returns `['index.html']` when root/index.html absent.
- scripts/check-dist-web.cjs exits 0 when empty, else prints names and exits 1; package.json `build` runs it after the web build.
- Four tests (nested, flat, Google Fonts ignored, missing root) in web-remote-assets.test.cjs.
- Gate: `npm run build:web` -> dist-web has index.html, app.js, app.css (flat); `node scripts/check-dist-web.cjs` -> "OK", exit 0; web-remote-assets.test.cjs 12 passed.

## relay-frames-fit-after-encoding — VERIFIED
- chunkFrames now accumulates per-byte escaped cost (2 for `"` `\`, 2/6 for control bytes, 1 otherwise), linear, with the UTF-8 back-off kept (remoteIpcDispatch.cjs ~L185-210).
- New test wraps frames as sendIpcResult does, encrypts with the real `encryptBox`, builds the `e2e:box`, asserts `< 256*1024`, `byteLength(JSON.stringify(data))-2 <= 180000`, and `joinFrames` round-trip, for quote/backslash/control/multibyte values.
- Gate: the four named test files -> 4 files, 76 tests passed.

## remote-renderer-real-chain-browser-test — VERIFIED
- Spec starts with `// @vitest-environment node`; `chromium.launch()` unguarded (fails, no skip); parent page from routed https origin; real RemoteRenderer bundled by esbuild from fixtures/remote-renderer-entry.tsx.
- Node side uses the REAL `remoteAssets.cjs` (assetManifest/readAsset) and REAL `chunkFrames`; frames delivered as `ipc:result` envelopes. No stubbing of those three.
- Flat case: probe -> `ipc:invoke` channel `probe` within 10 s (passed). Nested case: fallback, 0 iframes (passed).
- Real-build case gated on `SM_REAL_DIST_WEB=1`, asserts dist-web exists, setRoot(dist-web), waits 30 s for ipc:invoke.
- Gates: (1) full remote-app suite green (above); (2) build:web ok; (3) `SM_REAL_DIST_WEB=1 npm --prefix web/remote-app test -- src/__tests__/remote-renderer-chain.browser.spec.ts` -> 3 passed, 0 skipped, including the real built renderer (3.9 s).

## Findings
### Critical
- none
### Important
- none
### Minor
- web/remote-app/src/components/RemoteRenderer.tsx ~L313: the 15 s watchdog drops to the fallback if a legitimately booted renderer makes no IPC call within 15 s on a very slow link (chunked app.js transfer happens before 'ready', so the timer starts after transfer; low risk).
- remoteRenderer.spec.tsx has no dedicated test for AC 2 (index.html with no local script); behaviour is implemented (`boot.length === 0`) but unasserted.
- remoteAssets.cjs `missingEntryFiles` duplicates the loader's regexes by design (documented in the PRD); drift between the two is possible.
- Unrelated commits in the base..HEAD range (crossProjectFeedback, autoStartedSession) belong to other plans and were not reviewed here.

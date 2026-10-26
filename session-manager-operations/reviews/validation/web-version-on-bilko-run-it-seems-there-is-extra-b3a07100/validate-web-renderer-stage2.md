# Validation — web renderer stage 2

Base `f09026c4`; commits cf47da2e, 666af73f, b9ea294e, 879a6665, 35e140e0, 8633f511 (one per PRD). The range also holds unrelated Epic-reopen/fence commits; they were not reviewed here.
Gates re-run in a fresh worktree with SM_* unset:
- vitest (web-remote, remoteIpcDispatch, apiSurface, sendToRenderer, no-direct-webcontents-send, chatRunner, docEdit, crossProjectFeedback, pluginInstall, promptSessionEvents, voiceHotkey, remoteApi, web-remote-assets): 28 files / 313 tests passed.
- `npm run typecheck`, `npm run lint`: green. `npm run build:web`: green (dist-web: index.html, app.css, app.js).
- remote-app `ci`, `typecheck`, `test` (27 files / 175 tests), `build`: green. `manifest.json: 1158.3 KB gz`, which is under the 1270 KB budget.

## remote-ipc-invoke-envelope — VERIFIED
- index.cjs:19-20 installs `captureIpcHandlers(ipcMain)` right after the electron require, before the module requires. index.cjs:128-145 builds the dispatcher from apiSurface, the captured handlers and `webRemote.loadConfig`.
- webRemote.cjs `dispatchIpcInvoke`: 1-50 calls, channel and args shape validated, otherwise `respond {error:'rejected'}`. Audit line is `ipc:<channel>` with `ok` or `refused:<reason>`, with no args or result.
- `sendIpcResult` sends `ipc:result {id,seq,total,data}` from `chunkFrames`, encrypted with the client session key and unicast via `toConn`.
- webRemote.cjs:~933 `if (!type.startsWith('cmd:')) return;` drops a plaintext `ipc:invoke`. `dispatchEnvelope` is reached only from decrypted `e2e:box` or plaintext cmd.
- web-remote-ipc-invoke.test.cjs exists and passes. I did not read each of its cases; the run covers the read/unauth/mutate/batch/chunk criteria only as far as the test names and pass count go.

## remote-push-fanout — VERIFIED
- sendToRenderer.cjs exports `setRemoteFanout`. A hook test exists (sendToRenderer-fanout.test.cjs) and passes.
- webRemote.cjs `isPushableChannel` accepts only `on`/`on-dynamic` rows with remote not deny, matching prefixes for dynamic rows. `handleIpcSubscribe` only runs when `e2e.state === 'authenticated'`.
- `fanoutIpcEvent` targets only `_clients.authenticated()` clients with the channel in `pushChannels`, and sends chunked `ipc:event` frames. `pushChannels` lives on the per-client object, so it goes away with the client on disconnect (covered by web-remote-push-fanout.test.cjs).

## route-direct-sends-through-fanout — VERIFIED
- `no-direct-webcontents-send.test.cjs` exists and passes. Examples of migrated sites: index.cjs:1390 and 1404 use `sendIfAlive`.

## renderer-web-build — VERIFIED
- `apiSurface.json` is loaded and frozen by `apiSurface.cjs`; the drift test is green.
- `src/renderer/web/remoteApi.ts`:
  - It posts `sm-ipc` and `sm-ipc-subscribe` messages and rejects deny rows with `DENY_MESSAGE`.
  - It sets `__remote`.
  - `PERSISTENCE_CHANNELS` (sessions:save, promptSessions:merge-active-index, layout:save) resolve as no-ops, which is the single-writer guard.
- `vite.web.config.ts` stubs voice/VAD/onnx/workers (`src/renderer/web/stubs/`). `dist-web` is in `.gitignore:63` and `package.json:32`. The build emits one JS and one CSS file.

## desktop-serves-web-renderer — VERIFIED
- `remoteAssets.cjs` accepts only a basename, then checks `realpath` and that `dirname(real) === root`. It refuses `/`, `\`, NUL, `.` and `..`, and files over 25 MB. `assetManifest()` returns `available:false` when `dist-web` is missing.
- webRemote.cjs `dispatchAsset` refuses unless `client.e2e.state === 'authenticated'`, then replies with unicast, encrypted, chunked frames. web-remote-assets.test.cjs passes.

## web-shell-mounts-renderer — VERIFIED
- `RemoteRenderer.tsx:11` sets sandbox to `allow-scripts allow-popups allow-forms allow-modals allow-downloads`, with no `allow-same-origin`.
- sha256 is checked on both a cache hit (:73) and a fresh fetch (:75, which throws `HashMismatchError`).
- Batching is `FLUSH_MS=50` and `MAX_CALLS_PER_ENVELOPE=50`. `e.source !== win` ignores foreign messages (:287). Cockpit.tsx:111 keys the renderer by device and passes the drill-down as `fallback`. remoteRenderer.test.tsx passes.
- **E2E bypass check — none found.**
  - The `ipc:*` and `asset:*` handlers are reachable only through decrypted `e2e:box` (webRemote.cjs:~892-903). A plaintext `ipc:*` or `asset:*` falls into the `cmd:`-prefix drop.
  - The ipc dispatcher requires `e2e.state === 'authenticated'` (remoteIpcDispatch.cjs:132), and mutate requires `remoteEnabled && remoteControlEnabled` (:135).
  - Asset requests require authenticated state, and subscribe is ignored unless authenticated. A `pending_sas` client therefore gets nothing.

## Findings
Critical: none.
Important: none.
Minor:
1. The bundle is large: `app.js` is 6.7 MB raw (1.8 MB gz), about 9 MB base64, so roughly 50+ 180 KB frames at the relay's ~1 msg/s browser limit. The first load is slow, though the IndexedDB cache by sha256 means later loads are not. Consider splitting chunks or compressing before sending (webRemote.cjs `dispatchAsset`, `remoteAssets.cjs:readAsset`).
2. `RemoteRenderer.tsx:284` posts to the iframe with targetOrigin `'*'`. This is unavoidable for an opaque-origin sandbox, and the receiver is a fixed iframe.
3. `assetManifest()` reads and hashes every file on each call (`remoteAssets.cjs`). It is fine at this size, but a cache would help.

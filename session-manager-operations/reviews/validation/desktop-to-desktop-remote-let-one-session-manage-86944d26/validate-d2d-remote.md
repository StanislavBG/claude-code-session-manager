# Validation: desktop-to-desktop remote plan

Base: `bdbde4c8efeba89b0d66e5efb6373fcac98c8bc0` (HEAD `97f93631`). PRD files were in `prds-archived/`.

Gates re-run in the foreground, from this worktree (`node_modules` symlinked to the main checkout; scratch TMPDIR):
- Combined vitest over every gated test file plus `pty-output-batching`, `web-remote-e2e-pinning` and `SettingsRemote`: **12 files, 59 tests, all pass**.
- `npm run typecheck`: exit 0.
- `npm run lint`: exit 0.

## d2d-e2e-crypto-lib (1757) — VERIFIED
- `src/main/lib/feedback-remote/remoteE2eCrypto.cjs` is a new file (+109 lines) that requires only `node:crypto`.
- `webRemote.cjs` now requires the helpers from it, and the commit `e196eeed` is a refactor with no protocol change.
- `remoteE2eCrypto.test.cjs` covers matching SAS and keys, the encrypt/decrypt round trip, and tamper/wrong-key cases. It passes.
- `web-remote-e2e-pinning.test.cjs` is untouched and passes.
- Typecheck is green.

## d2d-pty-output-listeners (1758) — VERIFIED
- `pty.cjs` adds `addOutputListener`, which returns an unsubscribe function; the +53 lines are in the diff.
- `pty-output-listeners.test.cjs` covers delivery, unsubscribe, an isolated throwing listener, and clearing after exit. It passes.
- `pty-output-batching.test.cjs` still passes.

## d2d-agent-pty-stream (1759) — VERIFIED
- The listener is registered after `spawn` in `cmd:pty:spawn` (`webRemote.cjs` ~998). It replaces any existing stream for the same tabId through `stopRemotePtyStream`.
- Data is dropped unless `_e2e.state === 'authenticated'` and `loadConfigSync().remoteEnabled` (~1002, ~1007).
- `stopAllRemotePtyStreams` is called from `resetE2e` (237), `disconnect` (327), `handleTokenRevoked` (447), `revokeDevice` (1131) and `revokeAllDevices` (1156). `cmd:pty:kill` calls the per-tab stop (1028).
- `web-remote-pty-stream.test.cjs` proves the data is pushed as an e2e:box after authentication, nothing is pushed before SAS, and nothing is pushed after `revokeAllDevices`. It passes.
- The test hooks sit under a `__test` export.

## d2d-remote-client-core (1760) — VERIFIED
- `remoteClient.cjs` exports `createRemoteClient` plus a default singleton, and it does not import Electron.
- Peers persist via `writeJsonAtomicSync(..., {mode: 0o600})` (`remoteClient.cjs:47`).
- Key derivation uses `remoteE2eCrypto`. The TOFU pin is set in `confirmSas` (~247). A changed device key fails closed with `device_key_changed`.
- `send` rejects with `command_not_allowed` for anything not in `ALLOWED_COMMANDS` (~253).
- The test covers SAS parity, the round trip, timeout, non-allowlisted rejection, `device_key_changed` and the default `relay_client_auth_unavailable`. It passes.

## d2d-remote-client-ipc (1761) — VERIFIED
- `remoteClientIpc.cjs` defines zod schemas: `peerId` is a string of 1–128 chars, and `send.type` is refined against `ALLOWED_COMMANDS` (lines 18–24).
- `index.cjs` registers the handlers, and the preload `remoteClient` namespace and `api.d.ts` types are present in the diff.
- `remoteClientIpc.test.cjs` covers a malformed payload, a non-allowlisted type and a valid send. It passes.

## d2d-remote-ui-primitives (1766) — VERIFIED
- `remoteUi.tsx` exports `SectionLabel`, `PillButton`, `RemoteCard`, `RevokeButton`, `SasBanner` and `EmptyState`.
- `SettingsRemote.tsx` is rewired onto them with its file-local copies removed (−97 lines).
- `remoteUi.test.tsx` passes, and so does the existing `SettingsRemote.test.tsx`. That file was edited by 15 lines only for the 1764 case.
- Typecheck and lint are green.

## d2d-remote-terminal-panel (1762) — VERIFIED
- `RemoteTerminalPanel.tsx` has the `bg-bg-hi border border-line rounded-xl` frame (line 119) and a `remote-terminal-badge` Badge.
- The test covers spawn on mount, a matched-event write, a foreign-tabId event being ignored, kill plus unsubscribe on unmount, and the badge text. It passes.
- Not mounted by this PRD, as specified.

## d2d-remote-sessions-panel (1763) — VERIFIED
- `RemoteSessionsPanel.tsx` has the `remote-sessions-badge` testid, uses `RemoteCard`, `EmptyState` and `PillButton`, and reports errors through the toast.
- The test covers load-on-mount, the chat payload shape, a disabled empty prompt and the error toast. It passes.

## d2d-settings-remote-machines (1764) — VERIFIED
- `SettingsRemote.tsx:394` mounts `<RemoteMachinesSection />` directly after the Paired devices block. The `settings-remote-audit-toggle` button (line 398) follows it.
- The section imports only `remoteUi.tsx` primitives and `Badge`.
- The `relay_client_auth_unavailable` hint uses `remote-machine-unavailable` (`RemoteMachinesSection.tsx:58`).
- The component and `SettingsRemote` tests pass, and lint is green.

## Combined-diff review

28 files, +2352/−191.

**Security**
- **Relay token not logged.** `remoteClient.cjs` has no `console` or logger calls. The ticket appears only in the wss URL (`encodeURIComponent`), never in a log or an error message.
- **Peer store.** Peer private keys are written at 0600 with the atomic writer.
- **PTY stream gate.** The stream is gated on authenticated E2E and `remoteEnabled` at push time. Chunk content is never logged. It is torn down on revoke, token revocation, disconnect and E2E reset. The master "disable" handler calls `disconnect`, so the kill switch tears it down.
- **Send path.** The allowlist is enforced twice: in IPC (zod refine) and in the client `send`. The renderer cannot send arbitrary commands.

**UI consistency**
- The new components use the `remoteUi.tsx` primitives. The only ad-hoc class strings are the textarea (`RemoteSessionsPanel.tsx:110`), layout wrappers and the sage Badge override (see Minor).

### Critical
- None.

### Important
- `src/main/webRemote.cjs:1230`: `webRemote:disable-control` only clears `remoteControlEnabled`. It does not call `stopAllRemotePtyStreams`, and the stream gate checks only `remoteEnabled` (lines 1002, 1007). Remote ptys already spawned therefore keep streaming output to the peer after control is switched off, until revoke or disconnect. The six teardown paths listed in the PRD are all covered. This is a gap against the "kill switch" intent, so a follow-up is recommended. Either call `stopAllRemotePtyStreams()` in `disable-control` or also gate on `remoteControlEnabled`.

### Minor
- `RemoteMachinesSection.tsx:35` duplicates the sage Badge override (`!text-sage !border-sage/40`). It appears in 3 places: `SettingsRemote.tsx:59` and `:295`, and here. It could be a small `OnlineBadge` in `remoteUi.tsx`.
- `RemoteSessionsPanel.tsx:110`: the prompt textarea is a one-off class string, since there is no primitive for it. It is acceptable but could move into `remoteUi.tsx`.
- The 1766 criterion "SettingsRemote.test.tsx passes unchanged" was relaxed by the later 1764 case, which edits that file (+15 lines). This is legitimate.
- A stray 0-byte `<path>` file exists in the worktree (sqlite MCP placeholder, known). It was not committed.

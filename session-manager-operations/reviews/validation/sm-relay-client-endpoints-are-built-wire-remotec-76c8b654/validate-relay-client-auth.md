# Validation: relay client auth plan (1770, 1772, 1774, 1775, 1777, 1779)

Base: 8b2230ba66f1a537ae1a8b0aceea2a5e94cedb62. PRD files found in `prds-archived/`. Commits by PRD: 1770 `167aa1bf`; 1772 `1a60f93b`; 1774 `617e2d7d`; 1775 `488e8365`; 1777 `a7f3404a`; 1779 `d58d5504`.

Gates re-run in the worktree (node_modules symlinked to the main checkout, scratch TMPDIR):
- `vitest run` on relayClientAuth, remoteClient, remoteClientIpc and RemoteMachinesSection: 4 files, 40 tests passed.
- `npm run typecheck`: exit 0.
- `npm run lint`: exit 0 (smells OK, page-stewards clean).
- `web/remote-app`: `npm ci`, `typecheck` and `test` ran: 10 files, 38 tests passed. The panel spec logs a React act() warning on stderr and still passes.

## relay-client-auth-primitive (1770): VERIFIED
- Exports `createRelayClientAuth`, `relayClientAuth` and `RELAY_CLIENT_API_BASE='https://bilko.run/api/sm-relay'`; the object has all 7 methods (`relayClientAuth.cjs:135-137` and the return at `:128`).
- `pair` uppercases and trims the code, slices clientName to 64, omits it when empty, and writes the token at mode 0o600 via `writeJsonAtomicSync` (`:64-90`). 404 maps to `relay_client_auth_unavailable`, and other statuses map to `body.error || 'HTTP n'`.
- `authed()` (`:93-107`) throws `relay_client_unpaired` before any request when no token is stored. It sends the Bearer header, clears the token on 401, maps 404 to `relay_client_auth_unavailable`, and maps other non-2xx to `body.error` or `HTTP n`. A 200 without `ticket` throws `relay_auth_failed` (`:111`).
- `getDevicePubKey` throws `device_not_found` when the device is absent (`:121`).
- The default request refuses non-https, uses `rejectUnauthorized:true` and a 15 s timeout, and its errors carry only err.message, never headers.
- The test file covers every listed case, and it passes.

## phone-client-api (1772): VERIFIED
- The three types are in `types.ts`. `api.ts` adds `requestClientOtp` (POST `/client-otp`, bodyless), `getClients` (GET `/clients`) and `revokeClient` (DELETE with `encodeURIComponent`), all via `apiFetch`. api.spec passes (web gate green).

## remote-client-default-relay-auth (1774): VERIFIED
- `defaultRelayAuth` is gone and the default is `relayClientAuth` (`remoteClient.cjs:14,33`).
- The close handler takes `(code)`. Code 4001 calls `clearToken` and fails with `token_revoked` (`:234-240`). The `handleMessage` `token_revoked` branch also calls `clearToken` (`:149-151`).
- The tests inject `relayAuth` at every `createRemoteClient`, so none touches the network. The 4001 test, the 1000 test and the ticket-rejects test are present and pass.

## remote-client-pairing-ipc (1775): VERIFIED
- All five channels are registered with the specified behaviour (`remoteClientIpc.cjs:101-124`).
- The `pairCode` schema strips `-` and whitespace, uppercases, and checks `^[A-Za-z0-9]{8}$`. `clientName` is capped at 64, `deviceId` at 128 and `machineName` at 64, and malformed payloads throw before reaching `auth`.
- `add` strips `clientPrivateKey` before returning.
- The preload bindings are at `index.cjs:408-412`. The tests pass.

## phone-desktop-clients-panel (1777): VERIFIED
- `DesktopClientsPanel.tsx` has the testids, the exact copy, the 429 message, the `Unnamed desktop` fallback and revoke-then-reload. API errors render inline. The panel is mounted in `SessionNav`, and the spec passes.

## remote-machines-pairing-ui (1779): VERIFIED
- `api.d.ts` declares `RemoteClientDevice` and the five new API methods. `RemoteMachinesSection.tsx:9-12` handles `UNAVAILABLE` and the unpaired reasons (`relay_client_unpaired`, `token_revoked`). The component tests pass, and lint and typecheck are green.

## Plan-level checks
- **Token confinement:** the only `clientToken` occurrences are in `relayClientAuth.cjs`. It is absent from `remoteClient*.cjs`, `src/renderer`, `src/preload` and `web/remote-app`. The module has no logging. The IPC returns `{paired, clientId}`, `pair`'s `{ok, clientId, error}` and `{ok, devices}`, none of which contain the token. The thrown messages are fixed vocabulary strings, plus the server's `body.error`.
- **Tests don't touch bilko.run:** relayClientAuth tests inject `request`, remoteClient tests inject `relayAuth`, and the IPC tests inject the auth object.
- **404 end to end:** `authed()` 404 gives `relay_client_auth_unavailable`. `remoteClient.cjs:207-210` does `fail(peerId, e.message)`, so the peer reason is that string, and the renderer maps it to the unavailable copy.

## Findings
**Critical:** none.

**Important:** none.

**Minor:**
1. `remoteClientIpc.cjs:109`: `remoteClient:devices` returns `e.message` raw. This is safe today because it is only the fixed vocabulary or the server's `error` field, but the server string is unbounded.
2. The combined diff against the base also contains unrelated plans' commits (1773 `cmd:session:create`/`options`, 1778 `launchSession` and `NewSessionSheet`, and a release bump). I did not validate those here. Note that `cmd:session:create` checks cwd against open tabs and agentName against the persona list.
3. `DesktopClientsPanel.tsx:11`: the spec emits an act() warning on stderr (tests pass).
4. A `<path>` stray file (sqlite MCP placeholder) is untracked in the tree. It is known and not part of this plan.

Self-review of the diff covered input handling, secrets, path traversal and reuse. No `/code-review` or `/security-review` findings beyond those above.

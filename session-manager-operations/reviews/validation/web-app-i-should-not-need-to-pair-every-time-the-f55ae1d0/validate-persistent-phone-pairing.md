# Validation: persistent phone pairing

Base: 9bf8c7be (given). Commits: 9df6d945 (1933), a5540e48 (1936), fac6d784 (1939), 90645fa9 (1947), af9e8f1a (1949).
Note: node_modules was absent in the job worktree; ran `npm ci --ignore-scripts` (root) and `npm --prefix web/remote-app ci` (gitignored) to run gates.

Gates re-run (all green):
- Desktop: `vitest run` pin-live, e2e-pinning, multi-client, repair-identity, invalid-token, rekey = 6 files / 21 tests pass; `npm run typecheck` exit 0.
- Phone: `web/remote-app` typecheck exit 0; `npm test` = 18 files / 85 tests pass.

## 1933-remote-pin-check-live-config — VERIFIED
- e2e:hello reads pins from fresh `loadConfig()` matched by deviceId: src/main/webRemote.cjs:905-908.
- confirm-sas pins visible on same socket via saveConfig cache invalidation; covered by web-remote-pin-live.test.cjs (passes).
- Never-pinned key / other-deviceId pin still falls to pending_sas (`isPinnedPeerKey(live, …)`, else-path unchanged); tests (b),(c) pass.
- lastConnectedAt race fixed: `invalidateConfigCache()` before loadConfig, webRemote.cjs:434.
- Existing pinning/multi-client tests pass.

## 1936-phone-e2e-rehandshake-on-reconnect — VERIFIED
- `resetE2E(deviceId?)` clears sessionKey, keeps session/keypair: ws.ts:359-367.
- onclose calls resetE2E() and rejects pending with 'connection lost': ws.ts:300-304; pending tracks deviceId (ws.ts:547).
- `e2e:rekey` handled before dispatch; no deviceId ignored; re-sends e2e:hello with same browserPubKeyB64 when connected: ws.ts:409-427.
- App.tsx:124 `if (!online) socket.resetE2E(deviceId)`; connected branch unchanged.
- Spec e2e-rehandshake.spec.ts present, passes.

## 1939-phone-connect-screen-offline-desktops — VERIFIED
- Zero devices: primary 'Generate pairing code' (ConnectScreen.tsx:134); with devices: 'Your desktop is offline' (:82) and secondary 'Pair another computer' (:123).
- Forget: window.confirm then revokeDevice, errors to err (:36-42); 'Forget N offline' when >=2 (:146-152); Forget only on offline rows (:165).
- Order online first then issuedAt desc; 'last paired' on newest offline (:31-33, :161).
- connect-screen-offline.spec.tsx added; whole suite passes.

## 1947-remote-repair-keeps-identity — VERIFIED
- pair() loads cfg first, reuses newest entry with deviceId+both keys, sends same deviceId/pubkey: webRemote.cjs:1296-1309.
- Saved entry `{...prev, deviceId, deviceToken, issuedAt, lastConnectedAt:null}` only when relay echoes the same deviceId; otherwise fresh identity with empty pins: :1331-1350.
- Revoke paths empty cfg.devices so prev is undefined → fresh identity (test: after revokeAllDevices).
- connect() comment corrected (:379-381). Token not logged in diff.
- web-remote-repair-identity.test.cjs passes.

## 1949-remote-desktop-e2e-rekey — VERIFIED
- e2e:box with no sessionKey sends plaintext `e2e:rekey` `{reason:'no_session'}` via `respond(id,…,'e2e:rekey',client)` (toConn set for non-legacy): webRemote.cjs:928-936, respond :1020-1045; box still dropped.
- Throttle 5s per client key (`_lastRekeyMs`), cleared in resetE2e/teardownClient.
- Decrypt-failure path (session key present) untouched; no plaintext logged.
- Envelope matches ws.ts handler (type 'e2e:rekey', matches `msg.deviceId`, which the relay stamps on agent→browser frames, same as e2e:ready). Not exercised against a live relay.
- CLAUDE.md line added (web/remote-app/CLAUDE.md:39). web-remote-rekey.test.cjs passes.

## Security cross-check (webRemote.cjs)
- Never-pinned key still requires SAS: only `isPinnedPeerKey(live, key)` auto-trusts; live record is looked up by deviceId, falling back to the connect-time `device` — no new trust path.
- Revocation still forces fresh identity: pair() reuses only entries still present in cfg.devices; revokeDevice/revokeAllDevices/handleTokenRevoked untouched.
- No token/plaintext logged: new log lines (none added besides existing 'no session key' warn) carry no secrets.
- Mutate commands still gated on `client.e2e.state !== 'authenticated'` (webRemote.cjs:1000).

## Findings
### Critical
- none
### Important
- none
### Minor
- webRemote.cjs:905: `loadConfig()` is read on every e2e:hello (1s cache) — negligible cost, noted only.
- webRemote.cjs:1331: when reused, `...prev` keeps the old `deviceName`; harmless.
- Relay-side stamping of `deviceId` on e2e:rekey was verified by reading ws.ts only, not by a live relay run.
